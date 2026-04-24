"""
Toast Dashboard Scraper - Add this to scraper.py
=================================================

This replaces the broken API-based labor cost calculation with
direct scraping from the Toast dashboard, which has the real numbers.

INSTRUCTIONS:
1. Replace the Dockerfile and requirements.txt with the updated versions
2. In scraper.py, add this class near the top (after imports)
3. In run_scraper(), replace the labor cost calculation loop with the
   dashboard scraper approach (see MAIN LOOP CHANGES below)
4. Add these env vars to Railway:
   TOAST_EMAIL=andrew.shih87@gmail.com
   TOAST_PASSWORD=ZhongGuo87
"""

# ─── ADD THESE IMPORTS AT TOP OF scraper.py ─────────────────────────
# from playwright.sync_api import sync_playwright
# import re


# ─── ADD THIS CLASS AFTER ToastAPI CLASS ────────────────────────────

class ToastDashboardScraper:
    """
    Scrapes labor data directly from Toast's web dashboard.
    This gets the REAL numbers that match what managers see in Toast.
    """

    def __init__(self):
        self.email = os.environ.get("TOAST_EMAIL")
        self.password = os.environ.get("TOAST_PASSWORD")
        if not self.email or not self.password:
            raise ValueError("TOAST_EMAIL and TOAST_PASSWORD env vars required")

    def scrape_labor_data(self, locations):
        """
        Log into Toast dashboard and scrape labor cost breakdown for each location.

        Returns dict keyed by firestore_key:
          {
            "labor_webster": {"laborCost": 424.97, "netSales": 1977.76, "laborPercent": 21.5},
            "labor_maryland": {"laborCost": ..., "netSales": ..., "laborPercent": ...},
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
                    # Try generic input approach
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

        # Navigate to labor cost breakdown with today's date
        from datetime import datetime
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
        # The location selector is at the top of the page
        current_loc = page.locator('text=WEBSTER GROVES, text=MARYLAND HEIGHTS').first
        if current_loc.count() == 0:
            # Try to find and click location selector
            pass  # Will use whatever location is currently selected

        # Look for the location name to see which one we're on
        page_text = page.content()

        # If this location doesn't match, try to switch
        if loc["name"].upper() not in page_text.upper():
            # Click the location dropdown
            loc_selector = page.locator('[class*="location"], [data-testid*="location"]')
            if loc_selector.count() > 0:
                loc_selector.first.click()
                page.wait_for_timeout(1000)
                # Click the target location
                page.locator(f'text="{loc["name"]}"').first.click()
                page.wait_for_timeout(3000)

        # ── Extract the summary values ──
        # The labor breakdown page shows: Labor cost | Net sales | Labor % | SPLH
        # These are in the summary bar near the top

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
                # Get the parent container
                parent = el.evaluate_handle("el => el.closest('div')").as_element()
                if parent:
                    parent_text = parent.inner_text()
                    # Look for dollar amount pattern
                    match = re.search(r'\$([0-9,]+\.?\d*)', parent_text)
                    if match:
                        return float(match.group(1).replace(",", ""))

            # Strategy 2: Search the whole page for the pattern near the label
            content = page.content()
            # Find label position, then look for nearby dollar value
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


# ─── MAIN LOOP CHANGES ─────────────────────────────────────────────
#
# In run_scraper(), REPLACE the labor section of the main loop
# (lines ~728-775) with this:
#
# The old code does:
#   for loc in LOCATIONS:
#       labor_cost = api.calculate_labor_cost(...)
#       ...write labor-only...
#       net_sales = api.calculate_net_sales(...)
#       ...calculate labor_pct...
#       ...write to firestore...
#
# NEW CODE (replace the labor section inside the while True loop):
"""
            # ── Scrape labor data from Toast dashboard ──
            try:
                dashboard = ToastDashboardScraper()
                labor_results = dashboard.scrape_labor_data(LOCATIONS)

                for loc in LOCATIONS:
                    fkey = loc["firestore_key"]
                    if fkey in labor_results:
                        data = labor_results[fkey]
                        log(f"[{loc['name']}]")
                        log(f"  Labor: ${data['laborCost']:,.2f} / ${data['netSales']:,.2f} = {data['laborPercent']}%")

                        write_to_firestore(fkey, {
                            "laborPercent": data["laborPercent"],
                            "laborCost": data["laborCost"],
                            "netSales": data["netSales"],
                        })
                    else:
                        log(f"[{loc['name']}] No dashboard data available")

            except Exception as e:
                log(f"  Dashboard scrape failed: {e}")
                log(f"  Falling back to API-based calculation")
                # ... keep existing API-based code as fallback ...

            # ── 86 items (keep existing API-based code) ──
            for loc in LOCATIONS:
                try:
                    items_86 = api.get_86_items(loc["restaurant_guid"])
                    write_86_to_firestore(loc["firestore_key"], items_86)
                except Exception as e:
                    log(f"  86 fetch error for {loc['name']}: {e}")
"""
