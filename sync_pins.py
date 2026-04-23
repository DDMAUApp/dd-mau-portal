"""
Toast POS Access Code → DD Mau Portal PIN Sync
Logs into Toast Web, scrapes each employee's POS access code,
and updates the staff list in Firestore.

Environment variables needed (already in Railway):
  TOAST_EMAIL, TOAST_PASSWORD
  FIREBASE_SA_JSON
  TOAST_RESTAURANT_GUID_WEBSTER, TOAST_RESTAURANT_GUID_MARYLAND
"""

import os
import json
import asyncio
import logging
from playwright.async_api import async_playwright
import firebase_admin
from firebase_admin import credentials, firestore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger(__name__)

# Firebase setup
if not firebase_admin._apps:
    sa_json = os.environ.get("FIREBASE_SA_JSON", "{}")
    cred = credentials.Certificate(json.loads(sa_json))
    firebase_admin.initialize_app(cred)
db = firestore.client()

# Toast config
TOAST_EMAIL = os.environ.get("TOAST_EMAIL", "")
TOAST_PASSWORD = os.environ.get("TOAST_PASSWORD", "")

# Restaurant IDs (the long numeric format used in Toast Web URLs)
# Webster = 96394000000000000, Maryland = 96396000000000000
LOCATIONS = {
    "webster": {
        "restaurant_id": "96394000000000000",
        "guid": os.environ.get("TOAST_RESTAURANT_GUID_WEBSTER", "02aac3f1-5e8f-4b29-ab11-f68e7061bfdc"),
    },
    "maryland": {
        "restaurant_id": "96396000000000000",
        "guid": os.environ.get("TOAST_RESTAURANT_GUID_MARYLAND", "936388da-aa23-45fc-af17-67b2c5ea422a"),
    },
}


async def login_to_toast(page):
    """Log into Toast Web."""
    log.info("Logging into Toast Web...")
    await page.goto("https://www.toasttab.com/login")
    await page.wait_for_selector('input[type="email"], input[name="email"]', timeout=15000)
    await page.fill('input[type="email"], input[name="email"]', TOAST_EMAIL)
    await page.fill('input[type="password"], input[name="password"]', TOAST_PASSWORD)
    await page.click('button[type="submit"]')
    await page.wait_for_url("**/restaurants/**", timeout=30000)
    log.info("Logged in successfully.")


async def get_employee_passcode(page, employee_guid, restaurant_id):
    """Navigate to an employee's edit page and read their POS access code."""
    url = (
        f"https://www.toasttab.com/restaurants/admin/employees/summary/"
        f"{employee_guid}/edit/jobs-and-permissions"
        f"?restaurantId={restaurant_id}#Account-info"
    )
    try:
        await page.goto(url, wait_until="networkidle", timeout=20000)
    except Exception:
        await page.goto(url, timeout=20000)
        await page.wait_for_timeout(3000)

    # Click "Account info" tab if it exists
    try:
        account_link = page.locator('text="Account info"')
        if await account_link.count() > 0:
            await account_link.first.click()
            await page.wait_for_timeout(1500)
    except Exception:
        pass

    # Look for the POS access code input
    passcode = None

    # Try multiple selectors for the passcode input
    selectors = [
        'input[name*="passcode"]',
        'input[name*="accessCode"]',
        'input[name*="posAccessCode"]',
        'input[aria-label*="POS access"]',
        'input[aria-label*="passcode"]',
    ]

    for selector in selectors:
        try:
            el = page.locator(selector)
            if await el.count() > 0:
                val = await el.first.input_value()
                if val and val.strip():
                    passcode = val.strip()
                    break
        except Exception:
            continue

    # Fallback: find any input with a 3-8 digit numeric value near "POS access code" text
    if not passcode:
        try:
            # Look for the label "POS access code" and find the nearby input
            inputs = await page.query_selector_all("input")
            for inp in inputs:
                val = await inp.input_value()
                if val and val.strip().isdigit() and 3 <= len(val.strip()) <= 8:
                    passcode = val.strip()
                    break
        except Exception:
            pass

    return passcode


async def get_employee_list_from_api(location_guid):
    """Get employee names and GUIDs from Toast API."""
    import aiohttp

    # Authenticate
    async with aiohttp.ClientSession() as session:
        auth_resp = await session.post(
            "https://ws-api.toasttab.com/authentication/v1/authentication/login",
            json={
                "clientId": os.environ.get("TOAST_CLIENT_ID", "aDcKmeexlLcZlbxfpB0gfYgwO2mpBS2O"),
                "clientSecret": os.environ.get("TOAST_CLIENT_SECRET", ""),
                "userAccessType": "TOAST_MACHINE_CLIENT",
            },
        )
        auth_data = await auth_resp.json()
        token = auth_data["token"]["accessToken"]

        # Get employees
        emp_resp = await session.get(
            "https://ws-api.toasttab.com/labor/v1/employees",
            headers={
                "Authorization": f"Bearer {token}",
                "Toast-Restaurant-External-ID": location_guid,
            },
        )
        employees = await emp_resp.json()

    # Filter active employees
    result = []
    for e in employees:
        if e.get("deleted") or (e.get("deletedDate") and e["deletedDate"] != "1970-01-01T00:00:00.000+0000"):
            continue
        name = f"{(e.get('firstName') or '').strip()} {(e.get('lastName') or '').strip()}".strip()
        guid = e.get("v2EmployeeGuid") or e.get("guid", "")
        if name and guid:
            result.append({"name": name, "guid": guid})

    return result


async def sync_location(page, location_key, location_config):
    """Sync all employees for one location."""
    log.info(f"\n{'='*50}")
    log.info(f"Syncing {location_key.upper()} employees...")
    log.info(f"{'='*50}")

    # Get employee list from API
    employees = await get_employee_list_from_api(location_config["guid"])
    log.info(f"Found {len(employees)} active employees")

    results = []
    for i, emp in enumerate(employees):
        name = emp["name"]
        guid = emp["guid"]

        # Skip system accounts
        if name.lower() in ["default online ordering", "tds driver", "online order online order"]:
            log.info(f"  [{i+1}/{len(employees)}] Skipping system account: {name}")
            continue

        log.info(f"  [{i+1}/{len(employees)}] {name}...")
        passcode = await get_employee_passcode(page, guid, location_config["restaurant_id"])

        if passcode:
            log.info(f"    → POS code: {passcode}")
            results.append({"name": name, "passcode": passcode, "location": location_key})
        else:
            log.info(f"    → No POS code found")

    return results


async def update_firestore(all_results):
    """Update the staff list in Firestore with the new POS codes."""
    log.info(f"\n{'='*50}")
    log.info("Updating Firestore staff list...")
    log.info(f"{'='*50}")

    # Get current staff list
    doc_ref = db.document("config/staff")
    doc = doc_ref.get()
    if not doc.exists:
        log.error("No staff list found in Firestore!")
        return

    staff_list = doc.to_dict().get("list", [])
    log.info(f"Current staff list has {len(staff_list)} members")

    # Build lookup: name → passcode
    code_lookup = {}
    for r in all_results:
        code_lookup[r["name"].lower()] = r["passcode"]

    # Update PINs
    updated_count = 0
    for staff in staff_list:
        name = staff.get("name", "").strip()
        key = name.lower()
        if key in code_lookup:
            old_pin = staff.get("pin", "")
            new_pin = code_lookup[key]
            if old_pin != new_pin:
                log.info(f"  {name}: {old_pin} → {new_pin}")
                staff["pin"] = new_pin
                updated_count += 1
            else:
                log.info(f"  {name}: already {new_pin} ✓")

    if updated_count > 0:
        doc_ref.set({"list": staff_list})
        log.info(f"\nUpdated {updated_count} PINs in Firestore!")
    else:
        log.info("\nNo PINs needed updating.")

    # Log employees in Toast but not in portal
    portal_names = {s.get("name", "").lower() for s in staff_list}
    toast_names = {r["name"].lower() for r in all_results}
    missing = toast_names - portal_names
    if missing:
        log.info(f"\nEmployees in Toast but NOT in portal ({len(missing)}):")
        for m in sorted(missing):
            match = next((r for r in all_results if r["name"].lower() == m), None)
            if match:
                log.info(f"  - {match['name']} (code: {match['passcode']}, loc: {match['location']})")


async def main():
    log.info("Starting Toast POS Code Sync...")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()

        # Login
        await login_to_toast(page)

        # Sync both locations
        all_results = []

        for loc_key, loc_config in LOCATIONS.items():
            results = await sync_location(page, loc_key, loc_config)
            all_results.extend(results)

        await browser.close()

    log.info(f"\nTotal employees with POS codes: {len(all_results)}")

    # Update Firestore
    await update_firestore(all_results)

    log.info("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())
