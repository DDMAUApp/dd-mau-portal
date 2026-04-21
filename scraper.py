#!/usr/bin/env python3
"""
DD Mau — Toast POS Labor % via Dashboard Scraping
===================================================

Uses Playwright to scrape labor data directly from the Toast web dashboard,
which shows the REAL numbers that match what managers see in Toast.

Falls back to the REST API if the dashboard scrape fails.

Also fetches 86'd items via the Toast REST API and weekly schedule from Sling.

Runs every 90 seconds by default.

All config is via environment variables:
  TOAST_CLIENT_ID        — Toast API client ID
  TOAST_CLIENT_SECRET    — Toast API client secret
  TOAST_RESTAURANT_GUID_WEBSTER  — Restaurant GUID for Webster Groves
  TOAST_RESTAURANT_GUID_MARYLAND — Restaurant GUID for Maryland Heights
  TOAST_EMAIL            — Toast dashboard login email
  TOAST_PASSWORD         — Toast dashboard login password
  FIREBASE_SA_JSON       — Firebase service account key (entire JSON string)
  SCRAPE_INTERVAL        — Seconds between runs (default: 90)
"""

import json
import os
import re
import sys
import time
import traceback
from datetime import datetime, timezone, timedelta

import requests
from playwright.sync_api import sync_playwright

# ── CONFIG ────────────────────────────────────────────────────────────────────
TOAST_CLIENT_ID     = os.environ.get("TOAST_CLIENT_ID", "")
TOAST_CLIENT_SECRET = os.environ.get("TOAST_CLIENT_SECRET", "")
TOAST_API_HOST      = os.environ.get("TOAST_API_HOST", "https://ws-api.toasttab.com")

TOAST_EMAIL    = os.environ.get("TOAST_EMAIL", "")
TOAST_PASSWORD = os.environ.get("TOAST_PASSWORD", "")

LOCATIONS = [
    {
        "name": "Webster",
        "firestore_key": "webster",
        "restaurant_guid": os.environ.get("TOAST_RESTAURANT_GUID_WEBSTER", ""),
    },
    {
        "name": "Maryland Heights",
        "firestore_key": "maryland",
        "restaurant_guid": os.environ.get("TOAST_RESTAURANT_GUID_MARYLAND", ""),
    },
]

SCRAPE_INTERVAL_SECONDS = int(os.environ.get("SCRAPE_INTERVAL", "90"))
FIREBASE_PROJECT_ID = "dd-mau-staff-app"

# ──────────────────────────────────────────────────────────────────────────────

# ── Validate required config ─────────────────────────────────────────────────
missing = []
if not TOAST_CLIENT_ID:
    missing.append("TOAST_CLIENT_ID")
if not TOAST_CLIENT_SECRET:
    missing.append("TOAST_CLIENT_SECRET")
for loc in LOCATIONS:
    env_key = f"TOAST_RESTAURANT_GUID_{loc['firestore_key'].upper()}"
    if not loc["restaurant_guid"]:
        missing.append(env_key)
if missing:
    print("=" * 60)
    print("ERROR: Missing required environment variables:")
    for m in missing:
        print(f"  • {m}")
    print()
    print("Set these in Railway → Variables before deploying.")
    print("=" * 60)
    sys.exit(1)

# ── Firebase setup ───────────────────────────────────────────────────────────
import firebase_admin
from firebase_admin import credentials, firestore

SERVICE_ACCOUNT_PATH = os.path.join(os.path.dirname(__file__), "serviceAccountKey.json")
FIREBASE_SA_JSON = os.environ.get("FIREBASE_SA_JSON", "")

if FIREBASE_SA_JSON:
    sa_dict = json.loads(FIREBASE_SA_JSON)
    cred = credentials.Certificate(sa_dict)
    print("[init] Using Firebase credentials from FIREBASE_SA_JSON env var")
elif os.path.exists(SERVICE_ACCOUNT_PATH):
    cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
    print("[init] Using Firebase credentials from serviceAccountKey.json")
else:
    print("=" * 60)
    print("ERROR: No Firebase credentials found!")
    print("Set FIREBASE_SA_JSON env var or place serviceAccountKey.json here.")
    print("=" * 60)
    sys.exit(1)

firebase_admin.initialize_app(cred, {"projectId": FIREBASE_PROJECT_ID})
db = firestore.client()


# ── Helpers ──────────────────────────────────────────────────────────────────

def log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# ── Toast Dashboard Scraper (Playwright) ─────────────────────────────────────

class ToastDashboardScraper:
    """
    Scrapes labor data directly from Toast's web dashboard.
    This gets the REAL numbers that match what managers see in Toast.
    """

    def __init__(self):
        self.email = TOAST_EMAIL
        self.password = TOAST_PASSWORD
        if not self.email or not self.password:
            raise ValueError("TOAST_EMAIL and TOAST_PASSWORD env vars required for dashboard scraping")

    def scrape_labor_data(self, locations):
        """
        Log into Toast dashboard and scrape labor cost breakdown for each location.

        Returns dict keyed by firestore_key:
          {
            "webster": {"laborCost": 424.97, "netSales": 1977.76, "laborPercent": 21.5},
            "maryland": {"laborCost": ..., "netSales": ..., "laborPercent": ...},
          }
        """
        results = {}

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                viewport={"width": 1280, "height": 800},
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            )
            page = context.new_page()

            try:
                # ── Step 1: Login ──
                log("  [TOAST-WEB] Logging in...")
                page.goto("https://www.toasttab.com/login", wait_until="networkidle", timeout=30000)
                page.wait_for_timeout(2000)

                # Fill email
                email_input = page.locator('input[type="email"], input[name="email"], #email')
                if email_input.count() > 0:
                    email_input.first.fill(self.email)
                else:
                    page.locator('input').first.fill(self.email)

                # Fill password
                pw_input = page.locator('input[type="password"], input[name="password"], #password')
                if pw_input.count() > 0:
                    pw_input.first.fill(self.password)

                # Click login button
                login_btn = page.locator('button[type="submit"], button:has-text("Log in"), button:has-text("Sign in")')
                if login_btn.count() > 0:
                    login_btn.first.click()

                # Wait for redirect to dashboard
                page.wait_for_url("**/restaurants/admin/**", timeout=15000)
                page.wait_for_timeout(3000)
                log("  [TOAST-WEB] Logged in successfully")

                # ── Step 2: Scrape each location ──
                for loc in locations:
                    try:
                        result = self._scrape_location(page, loc)
                        if result:
                            results[loc["firestore_key"]] = result
                    except Exception as e:
                        log(f"  [TOAST-WEB] Error scraping {loc['name']}: {e}")

            except Exception as e:
                log(f"  [TOAST-WEB] Login/scrape failed: {e}")
            finally:
                browser.close()

        return results

    def _scrape_location(self, page, loc):
        """Scrape labor data for a single location from the labor breakdown page."""
        log(f"  [TOAST-WEB] Scraping {loc['name']}...")

        from zoneinfo import ZoneInfo
        now_ct = datetime.now(ZoneInfo("America/Chicago"))
        date_str = now_ct.strftime("%Y%m%d")

        url = (
            f"https://www.toasttab.com/restaurants/admin/reports/labor/"
            f"labor-cost-breakdown?datePreset=TODAY"
            f"&startDate={date_str}&endDate={date_str}"
        )

        page.goto(url, wait_until="networkidle", timeout=30000)
        page.wait_for_timeout(3000)

        # Check if we need to switch restaurant location
        page_text = page.content()

        if loc["name"].upper() not in page_text.upper():
            # Try to click the location dropdown and switch
            loc_selector = page.locator('[class*="location"], [data-testid*="location"]')
            if loc_selector.count() > 0:
                loc_selector.first.click()
                page.wait_for_timeout(1000)
                page.locator(f'text="{loc["name"]}"').first.click()
                page.wait_for_timeout(3000)

        # ── Extract the summary values ──
        labor_cost = self._extract_dollar_value(page, "Labor cost")
        net_sales = self._extract_dollar_value(page, "Net sales")
        labor_pct = self._extract_percent_value(page, "Labor %")

        if labor_cost is not None and net_sales is not None and labor_pct is not None:
            log(f"  [TOAST-WEB] {loc['name']}: Labor ${labor_cost:,.2f}, "
                f"Sales ${net_sales:,.2f}, Labor% {labor_pct}%")
            return {
                "laborCost": round(labor_cost, 2),
                "netSales": round(net_sales, 2),
                "laborPercent": round(labor_pct, 2),
            }
        else:
            log(f"  [TOAST-WEB] Could not extract all values for {loc['name']}")
            log(f"    laborCost={labor_cost}, netSales={net_sales}, laborPct={labor_pct}")
            return None

    def _extract_dollar_value(self, page, label):
        """Extract a dollar value that appears near a label on the page."""
        try:
            # Strategy 1: Find the label text, then get the nearby dollar value
            elements = page.query_selector_all(f'text="{label}"')
            for el in elements:
                parent = el.evaluate_handle("el => el.closest('div')").as_element()
                if parent:
                    parent_text = parent.inner_text()
                    match = re.search(r'\$([0-9,]+\.?\d*)', parent_text)
                    if match:
                        return float(match.group(1).replace(",", ""))

            # Strategy 2: Search the whole page for the pattern near the label
            content = page.content()
            pattern = rf'{label}[^$]*?\$([0-9,]+\.?\d*)'
            match = re.search(pattern, content, re.IGNORECASE)
            if match:
                return float(match.group(1).replace(",", ""))

        except Exception as e:
            log(f"    Error extracting {label}: {e}")
        return None

    def _extract_percent_value(self, page, label):
        """Extract a percentage value that appears near a label on the page."""
        try:
            elements = page.query_selector_all(f'text="{label}"')
            for el in elements:
                parent = el.evaluate_handle("el => el.closest('div')").as_element()
                if parent:
                    parent_text = parent.inner_text()
                    match = re.search(r'(\d+\.?\d*)%', parent_text)
                    if match:
                        return float(match.group(1))

            # Fallback: search page content
            content = page.content()
            pattern = rf'{label}[^%]*?(\d+\.?\d*)%'
            match = re.search(pattern, content, re.IGNORECASE)
            if match:
                return float(match.group(1))

        except Exception as e:
            log(f"    Error extracting {label}: {e}")
        return None


# ── Toast API client (used for 86 items + fallback labor) ──────────────────

class ToastAPI:
    """Thin wrapper around the Toast REST API."""

    def __init__(self, client_id, client_secret, api_host):
        self.client_id = client_id
        self.client_secret = client_secret
        self.api_host = api_host.rstrip("/")
        self.access_token = None
        self.token_expiry = 0  # epoch seconds

    def authenticate(self):
        """POST /authentication/v1/authentication/login to get a bearer token."""
        log("Authenticating with Toast API...")
        resp = requests.post(
            f"{self.api_host}/authentication/v1/authentication/login",
            json={
                "clientId": self.client_id,
                "clientSecret": self.client_secret,
                "userAccessType": "TOAST_MACHINE_CLIENT",
            },
            headers={"Content-Type": "application/json"},
            timeout=30,
        )
        if resp.status_code != 200:
            log(f"  Auth failed: {resp.status_code} — {resp.text[:500]}")
            resp.raise_for_status()

        data = resp.json()
        token_obj = data.get("token", data)
        self.access_token = token_obj.get("accessToken") or token_obj.get("access_token")
        expires_in = token_obj.get("expiresIn", 3600)
        self.token_expiry = time.time() + expires_in - 60
        log(f"  Authenticated OK (token expires in {expires_in}s)")

    def _ensure_token(self):
        if not self.access_token or time.time() >= self.token_expiry:
            self.authenticate()

    def _headers(self, restaurant_guid):
        self._ensure_token()
        return {
            "Authorization": f"Bearer {self.access_token}",
            "Toast-Restaurant-External-ID": restaurant_guid,
            "Content-Type": "application/json",
        }

    # ── Labor (fallback — known to return incomplete data) ─────────
    def get_time_entries(self, restaurant_guid, date_str):
        url = f"{self.api_host}/labor/v1/timeEntries"
        start_dt = f"{date_str}T00:00:00.000+0000"
        end_dt   = f"{date_str}T23:59:59.999+0000"
        params = {"startDate": start_dt, "endDate": end_dt}
        resp = requests.get(url, headers=self._headers(restaurant_guid), params=params, timeout=30)
        if resp.status_code != 200:
            log(f"  timeEntries error: {resp.status_code} — {resp.text[:500]}")
            resp.raise_for_status()
        return resp.json()

    def calculate_labor_cost(self, restaurant_guid, date_str):
        entries = self.get_time_entries(restaurant_guid, date_str)
        total_cost = 0.0
        employee_count = 0
        for entry in entries:
            wage = entry.get("hourlyWage")
            if wage is None:
                continue
            regular  = entry.get("regularHours") or 0
            overtime = entry.get("overtimeHours") or 0
            cost = (regular * wage) + (overtime * wage * 1.5)
            total_cost += cost
            employee_count += 1
        log(f"  Labor (API fallback): ${total_cost:,.2f} from {employee_count} hourly entries "
            f"({len(entries)} total entries)")
        return total_cost

    # ── Orders / Net Sales (fallback) ─────────────────────────────
    def get_orders(self, restaurant_guid, business_date):
        url = f"{self.api_host}/orders/v2/orders"
        params = {"businessDate": business_date}
        all_orders = []
        page = 0
        while page < 20:
            params_page = {**params, "pageSize": 100, "page": page}
            resp = requests.get(url, headers=self._headers(restaurant_guid), params=params_page, timeout=60)
            if resp.status_code != 200:
                log(f"  orders error: {resp.status_code} — {resp.text[:500]}")
                resp.raise_for_status()
            batch = resp.json()
            if isinstance(batch, list):
                if not batch:
                    break
                all_orders.extend(batch)
                if len(batch) < 100:
                    break
                page += 1
            elif isinstance(batch, dict):
                items = batch.get("orders", batch.get("results", batch.get("data", [])))
                if isinstance(items, list):
                    all_orders.extend(items)
                    if len(items) < 100:
                        break
                    page += 1
                else:
                    all_orders.append(batch)
                    break
            else:
                break
        log(f"  Fetched {len(all_orders)} orders")
        return all_orders

    def get_order_details(self, restaurant_guid, order_guid):
        url = f"{self.api_host}/orders/v2/orders/{order_guid}"
        resp = requests.get(url, headers=self._headers(restaurant_guid), timeout=30)
        if resp.status_code != 200:
            return None
        return resp.json()

    def calculate_net_sales(self, restaurant_guid, business_date):
        orders = self.get_orders(restaurant_guid, business_date)
        net_sales = 0.0
        order_count = 0
        guid_orders = [o for o in orders if isinstance(o, str)]
        if guid_orders:
            log(f"  Orders returned as GUIDs ({len(guid_orders)} of {len(orders)})")
        fetched_individually = 0
        MAX_INDIVIDUAL_FETCHES = 200
        for order in orders:
            if isinstance(order, str):
                if fetched_individually >= MAX_INDIVIDUAL_FETCHES:
                    continue
                fetched_individually += 1
                full_order = self.get_order_details(restaurant_guid, order)
                if full_order:
                    checks = full_order.get("checks", [])
                else:
                    continue
            else:
                checks = order.get("checks")
                if checks is None:
                    guid = order.get("guid")
                    if guid and isinstance(guid, str):
                        if fetched_individually >= MAX_INDIVIDUAL_FETCHES:
                            continue
                        fetched_individually += 1
                        full_order = self.get_order_details(restaurant_guid, guid)
                        if full_order:
                            checks = full_order.get("checks", [])
                        else:
                            continue
                    else:
                        continue
            for check in checks:
                amt = check.get("amount") or 0
                net_sales += amt
            order_count += 1
        log(f"  Net sales (API fallback): ${net_sales:,.2f} from {order_count} checks"
            + (f" ({fetched_individually} fetched individually)" if fetched_individually else ""))
        return net_sales

    # ── Stock / 86 Items ──────────────────────────────────────────
    def get_stock_inventory(self, restaurant_guid):
        url = f"{self.api_host}/stock/v1/inventory"
        resp = requests.get(url, headers=self._headers(restaurant_guid), timeout=30)
        if resp.status_code != 200:
            log(f"  stock inventory error: {resp.status_code} — {resp.text[:500]}")
            resp.raise_for_status()
        return resp.json()

    def get_menu_items(self, restaurant_guid):
        if not hasattr(self, '_menu_cache'):
            self._menu_cache = {}
        if restaurant_guid in self._menu_cache:
            cache_time, cache_data = self._menu_cache[restaurant_guid]
            if time.time() - cache_time < 1800:
                return cache_data

        menu_map = {}
        headers = self._headers(restaurant_guid)

        # Attempt 1: /config/v2/menuItems
        try:
            url = f"{self.api_host}/config/v2/menuItems"
            all_items = []
            page_token = None
            while True:
                params = {"pageSize": 100}
                if page_token:
                    params["pageToken"] = page_token
                resp = requests.get(url, headers=headers, params=params, timeout=60)
                if resp.status_code != 200:
                    log(f"  config/v2/menuItems: {resp.status_code}")
                    break
                data = resp.json()
                if isinstance(data, list):
                    all_items.extend(data)
                    break
                elif isinstance(data, dict):
                    items = data.get("menuItems", data.get("results", data.get("data", [])))
                    if isinstance(items, list):
                        all_items.extend(items)
                    page_token = data.get("nextPageToken")
                    if not page_token:
                        break
                else:
                    break
            for item in all_items:
                guid = item.get("guid") or item.get("multiLocationId")
                name = item.get("name", "")
                if guid and name:
                    menu_map[guid] = name
            if menu_map:
                log(f"  Loaded {len(menu_map)} menu items via config API")
        except Exception as e:
            log(f"  config/v2/menuItems failed: {e}")

        # Attempt 2: /menus/v2/menus
        if not menu_map:
            try:
                url = f"{self.api_host}/menus/v2/menus"
                resp = requests.get(url, headers=headers, timeout=60)
                if resp.status_code == 200:
                    menus = resp.json()
                    if isinstance(menus, list):
                        for menu in menus:
                            groups = menu.get("groups", menu.get("menuGroups", []))
                            if isinstance(groups, list):
                                for group in groups:
                                    items = group.get("items", group.get("menuItems", []))
                                    if isinstance(items, list):
                                        for item in items:
                                            guid = item.get("guid") or item.get("multiLocationId")
                                            name = item.get("name", "")
                                            if guid and name:
                                                menu_map[guid] = name
                    if menu_map:
                        log(f"  Loaded {len(menu_map)} menu items via menus API")
                else:
                    log(f"  menus/v2/menus: {resp.status_code}")
            except Exception as e:
                log(f"  menus/v2/menus failed: {e}")

        # Attempt 3: /menus/v2/menuItems
        if not menu_map:
            try:
                url = f"{self.api_host}/menus/v2/menuItems"
                resp = requests.get(url, headers=headers, params={"pageSize": 100}, timeout=60)
                if resp.status_code == 200:
                    data = resp.json()
                    items = data if isinstance(data, list) else data.get("menuItems", [])
                    for item in items:
                        guid = item.get("guid")
                        name = item.get("name", "")
                        if guid and name:
                            menu_map[guid] = name
                    if menu_map:
                        log(f"  Loaded {len(menu_map)} menu items via menuItems API")
                else:
                    log(f"  menus/v2/menuItems: {resp.status_code}")
            except Exception as e:
                log(f"  menus/v2/menuItems failed: {e}")

        if not menu_map:
            log(f"  Warning: Could not load menu item names from any API")
        self._menu_cache[restaurant_guid] = (time.time(), menu_map)
        return menu_map

    def get_86_items(self, restaurant_guid):
        inventory = self.get_stock_inventory(restaurant_guid)
        if not inventory:
            log("  No 86'd items found")
            return []
        try:
            menu_map = self.get_menu_items(restaurant_guid)
        except Exception as e:
            log(f"  Warning: Could not fetch menu items for names: {e}")
            menu_map = {}
        items_86 = []
        for entry in inventory:
            if isinstance(entry, dict):
                status = entry.get("status", "")
                guid = entry.get("menuItemId") or entry.get("guid") or entry.get("multiLocationId", "")
                quantity = entry.get("quantity")
                name = menu_map.get(guid, f"Item {guid[:8]}..." if guid else "Unknown")
                items_86.append({
                    "name": name,
                    "guid": guid,
                    "status": status,
                    "quantity": quantity,
                })
        log(f"  86'd items: {len(items_86)} items out of stock")
        return items_86


# ── Firestore writer ─────────────────────────────────────────────────────────

def write_to_firestore(location_key, data):
    """Write labor data to Firestore for the DD Mau app to read."""
    now = datetime.now(timezone.utc).isoformat()
    now_local = datetime.now()
    today_key = now_local.strftime("%Y-%m-%d")
    time_str  = now_local.strftime("%-I:%M %p")

    doc_data = {
        "laborPercent": data["laborPercent"],
        "updatedAt": now,
        "source": data.get("source", "toast-dashboard"),
    }

    # Still store laborCost/netSales in Firestore for admin reference,
    # but the portal dashboard only displays laborPercent to staff.
    if data.get("laborCost") is not None:
        doc_data["laborCost"] = data["laborCost"]
    if data.get("netSales") is not None:
        doc_data["netSales"] = data["netSales"]

    # Write current state
    db.collection("ops").document(f"labor_{location_key}").set(doc_data, merge=True)
    log(f"  → Firestore: ops/labor_{location_key}")

    # Save to history for the trend chart
    history_ref = db.collection(f"laborHistory_{location_key}").document()
    history_ref.set({
        "laborPercent": data["laborPercent"],
        "laborCost": data.get("laborCost"),
        "netSales": data.get("netSales"),
        "date": today_key,
        "time": time_str,
        "timestamp": firestore.SERVER_TIMESTAMP,
    })


def write_86_to_firestore(location_key, items_86):
    """Write 86'd items to Firestore for the DD Mau app to read."""
    now = datetime.now(timezone.utc).isoformat()
    doc_data = {
        "items": items_86,
        "count": len(items_86),
        "updatedAt": now,
        "source": "toast-api",
    }
    db.collection("ops").document(f"86_{location_key}").set(doc_data, merge=True)
    log(f"  → Firestore: ops/86_{location_key} ({len(items_86)} items)")


# ── Sling schedule fetcher ───────────────────────────────────────────────────

SLING_BASE  = "https://api.getsling.com"
SLING_TOKEN = os.environ.get("SLING_TOKEN", "")
SLING_ORG_ID = os.environ.get("SLING_ORG_ID", "360661")


def fetch_sling_schedule():
    """
    Pull this week's schedule from Sling API and write to Firestore.
    """
    if not SLING_TOKEN:
        log("[SLING] No SLING_TOKEN configured — skipping schedule fetch")
        return False

    from zoneinfo import ZoneInfo
    now_ct  = datetime.now(ZoneInfo("America/Chicago"))
    monday  = now_ct - timedelta(days=now_ct.weekday())
    sunday  = monday + timedelta(days=6)
    start_date = monday.strftime("%Y-%m-%d")
    end_date   = sunday.strftime("%Y-%m-%d")

    headers = {"Authorization": SLING_TOKEN}

    try:
        # 1. Fetch users for name lookup
        resp = requests.get(f"{SLING_BASE}/v1/users", headers=headers, timeout=30)
        if resp.status_code != 200:
            log(f"[SLING] Users endpoint failed: HTTP {resp.status_code}")
            return False
        users_data = resp.json()
        user_map = {}
        for u in users_data:
            uid   = u.get("id")
            name  = u.get("name", "").strip()
            lname = u.get("lastname", "").strip()
            if uid and name:
                full_name = f"{name} {lname}".strip() if lname else name
                user_map[uid] = full_name
        log(f"[SLING] Loaded {len(user_map)} users")

        # 1b. Fetch locations
        location_map = {}
        try:
            resp_loc = requests.get(f"{SLING_BASE}/v1/locations", headers=headers, timeout=30)
            if resp_loc.status_code == 200:
                locations_data = resp_loc.json()
                if isinstance(locations_data, list):
                    for loc in locations_data:
                        loc_id   = loc.get("id")
                        loc_name = loc.get("name", "").strip()
                        if loc_id and loc_name:
                            location_map[loc_id] = loc_name
                log(f"[SLING] Loaded {len(location_map)} locations: {location_map}")
            else:
                log(f"[SLING] Locations endpoint: HTTP {resp_loc.status_code} (non-fatal)")
        except Exception as loc_err:
            log(f"[SLING] Locations fetch error (non-fatal): {loc_err}")

        # 2. Fetch timesheets (shifts) for this week
        resp = requests.get(
            f"{SLING_BASE}/v1/reports/timesheets",
            headers=headers,
            params={"dates": f"{start_date}/{end_date}"},
            timeout=30,
        )
        if resp.status_code != 200:
            log(f"[SLING] Timesheets endpoint failed: HTTP {resp.status_code}")
            return False

        shifts = resp.json()
        if not isinstance(shifts, list):
            log(f"[SLING] Unexpected timesheets response type: {type(shifts)}")
            return False
        log(f"[SLING] Fetched {len(shifts)} shifts for {start_date} to {end_date}")

        # 3. Transform into calendar-friendly structure
        schedule_by_date = {}
        for shift in shifts:
            if shift.get("type") != "shift":
                continue
            if shift.get("status") not in ("published", "confirmed"):
                continue

            dtstart = shift.get("dtstart", "")
            dtend   = shift.get("dtend", "")
            if not dtstart:
                continue

            date_key = dtstart[:10]

            user_info = shift.get("user") or {}
            user_id   = user_info.get("id") if isinstance(user_info, dict) else None
            user_name = user_map.get(user_id, "Unassigned") if user_id else "Open Shift"

            loc_info = shift.get("location") or {}
            loc_id   = loc_info.get("id") if isinstance(loc_info, dict) else None

            start_time = dtstart[11:16] if len(dtstart) > 15 else ""
            end_time   = dtend[11:16] if len(dtend) > 15 else ""
            loc_name   = location_map.get(loc_id, "Unknown")

            entry = {
                "name": user_name,
                "start": start_time,
                "end": end_time,
                "dtstart": dtstart,
                "dtend": dtend,
                "locationId": loc_id,
                "locationName": loc_name,
            }
            if date_key not in schedule_by_date:
                schedule_by_date[date_key] = []
            schedule_by_date[date_key].append(entry)

        for date_key in schedule_by_date:
            schedule_by_date[date_key].sort(key=lambda s: s["start"])

        total_shifts = sum(len(v) for v in schedule_by_date.values())
        log(f"[SLING] Processed {total_shifts} published shifts across {len(schedule_by_date)} days")

        # 4. Write to Firestore
        write_schedule_to_firestore(schedule_by_date, start_date, end_date, location_map)
        return True

    except Exception as e:
        log(f"[SLING] Schedule fetch error: {e}")
        traceback.print_exc()
        return False


def write_schedule_to_firestore(schedule_by_date, week_start, week_end, location_map=None):
    """Write weekly schedule to Firestore for the portal calendar."""
    now = datetime.now(timezone.utc).isoformat()
    loc_map_str = {}
    if location_map:
        loc_map_str = {str(k): v for k, v in location_map.items()}

    doc_data = {
        "weekStart": week_start,
        "weekEnd": week_end,
        "schedule": schedule_by_date,
        "locations": loc_map_str,
        "updatedAt": now,
        "source": "sling-api",
    }
    db.collection("ops").document("schedule").set(doc_data, merge=True)
    log(f"  → Firestore: ops/schedule (week {week_start} to {week_end})")


# ── Main loop ────────────────────────────────────────────────────────────────

def run_scraper():
    log("=" * 55)
    log("DD Mau Toast Scraper — Dashboard + 86 Items")
    log(f"Interval: {SCRAPE_INTERVAL_SECONDS}s")
    log(f"Locations: {[loc['name'] for loc in LOCATIONS]}")
    log(f"Dashboard scraping: {'ENABLED' if TOAST_EMAIL and TOAST_PASSWORD else 'DISABLED (no credentials)'}")
    log("=" * 55)

    api = ToastAPI(TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, TOAST_API_HOST)

    # Initial auth check
    try:
        api.authenticate()
    except Exception as e:
        log(f"FATAL: Could not authenticate — {e}")
        sys.exit(1)

    # ── Sling schedule tracking ──
    sling_last_fetch = 0
    SLING_FETCH_INTERVAL = 900  # 15 minutes

    consecutive_failures = 0

    while True:
        try:
            from zoneinfo import ZoneInfo
            now_ct   = datetime.now(ZoneInfo("America/Chicago"))
            date_iso = now_ct.strftime("%Y-%m-%d")
            date_biz = now_ct.strftime("%Y%m%d")

            log(f"--- Fetching labor data (business date: {date_iso}) ---")

            # ═══════════════════════════════════════════════════════════
            # LABOR: Try dashboard scraping first, fall back to API
            # ═══════════════════════════════════════════════════════════
            dashboard_success = False

            if TOAST_EMAIL and TOAST_PASSWORD:
                try:
                    dashboard = ToastDashboardScraper()
                    labor_results = dashboard.scrape_labor_data(LOCATIONS)

                    for loc in LOCATIONS:
                        fkey = loc["firestore_key"]
                        if fkey in labor_results:
                            data = labor_results[fkey]
                            log(f"[{loc['name']}]")
                            log(f"  Labor: ${data['laborCost']:,.2f} / "
                                f"${data['netSales']:,.2f} = {data['laborPercent']}%")

                            write_to_firestore(fkey, {
                                "laborPercent": data["laborPercent"],
                                "laborCost": data["laborCost"],
                                "netSales": data["netSales"],
                                "source": "toast-dashboard",
                            })
                            dashboard_success = True
                        else:
                            log(f"[{loc['name']}] No dashboard data — will try API fallback")

                except Exception as e:
                    log(f"  Dashboard scrape failed: {e}")
                    traceback.print_exc()
                    log(f"  Falling back to API-based calculation...")

            # ── API fallback if dashboard didn't work ──
            if not dashboard_success:
                log("  Using API fallback for labor data...")
                for loc in LOCATIONS:
                    try:
                        log(f"[{loc['name']}]")

                        labor_cost = api.calculate_labor_cost(
                            loc["restaurant_guid"], date_iso
                        )

                        if labor_cost > 0:
                            write_to_firestore(loc["firestore_key"], {
                                "laborPercent": 100.0,
                                "laborCost": round(labor_cost, 2),
                                "netSales": 0,
                                "source": "toast-api-fallback",
                            })
                            log(f"  → Wrote labor-only (${labor_cost:,.2f}, waiting for sales)")

                        net_sales = 0.0
                        try:
                            net_sales = api.calculate_net_sales(
                                loc["restaurant_guid"], date_biz
                            )
                        except Exception as e:
                            log(f"  Net sales fetch failed: {e}")
                            log(f"  Continuing with net_sales=0")

                        if net_sales > 0:
                            labor_pct = round((labor_cost / net_sales) * 100, 2)
                        elif labor_cost > 0:
                            labor_pct = 100.0
                        else:
                            labor_pct = 0.0

                        log(f"  Labor %: {labor_pct}% "
                            f"(${labor_cost:,.2f} / ${net_sales:,.2f})")

                        write_to_firestore(loc["firestore_key"], {
                            "laborPercent": labor_pct,
                            "laborCost": round(labor_cost, 2),
                            "netSales": round(net_sales, 2),
                            "source": "toast-api-fallback",
                        })

                    except requests.exceptions.HTTPError as e:
                        status = e.response.status_code if e.response else "?"
                        log(f"  API error for {loc['name']}: HTTP {status}")
                        if status == 401:
                            log("  Token expired — will re-auth next cycle")
                            api.access_token = None
                        consecutive_failures += 1
                    except Exception as e:
                        log(f"  Error for {loc['name']}: {e}")
                        traceback.print_exc()
                        consecutive_failures += 1

            # ═══════════════════════════════════════════════════════════
            # 86 ITEMS: Always use API (this works fine)
            # ═══════════════════════════════════════════════════════════
            for loc in LOCATIONS:
                try:
                    items_86 = api.get_86_items(loc["restaurant_guid"])
                    write_86_to_firestore(loc["firestore_key"], items_86)
                except Exception as e:
                    log(f"  86 fetch error for {loc['name']}: {e}")

            consecutive_failures = 0

            # ── Sling schedule fetch (every 15 min) ──
            now_epoch = time.time()
            if now_epoch - sling_last_fetch >= SLING_FETCH_INTERVAL:
                try:
                    if fetch_sling_schedule():
                        sling_last_fetch = now_epoch
                except Exception as e:
                    log(f"[SLING] Error: {e}")

        except Exception as e:
            log(f"Error in main loop: {e}")
            traceback.print_exc()
            consecutive_failures += 1

        if consecutive_failures > 20:
            log("Too many consecutive failures — forcing re-auth")
            api.access_token = None
            consecutive_failures = 0

        log(f"Sleeping {SCRAPE_INTERVAL_SECONDS}s...")
        time.sleep(SCRAPE_INTERVAL_SECONDS)


if __name__ == "__main__":
    try:
        run_scraper()
    except KeyboardInterrupt:
        log("Scraper stopped (Ctrl+C)")
