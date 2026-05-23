# Vendor Pricing And Order History Integration Plan

This is the handoff plan for rebuilding DD Mau vendor pricing so Sysco and US Foods data becomes reliable restaurant operations data, not a fragile live scraper dependency.

## 1. Diagnose The Current Scraper

Current repo finding: `scripts/usfoods_scraper.py` logs into US Foods, retrieves an email-based 2FA code through Gmail IMAP, tries to download an order-guide CSV, falls back to DOM scraping, then merges results into `vendor_prices/usfoods`. `Operations.jsx` reads `vendor_prices/sysco`, `vendor_prices/usfoods`, their status docs, and trigger docs.

Before changing scraper selectors, answer these questions:

- Does the vendor explicitly allow automation, export automation, API use, EDI, SFTP, or scheduled report delivery for this account?
- Does failure happen before login, during MFA, after redirect, at list selection, during CSV export, during parsing, or during Firestore write?
- Does a human login from the same server/IP/browser profile work at the same time?
- Did the vendor change portal branding, auth provider, list page route, export modal, column names, pagination, or report format?
- Are failures correlated with time of day, repeated retries, headless browser use, MFA prompts, location/account switching, or large order guides?

Collect these logs on every run:

- `sync_job_id`, vendor, account, location, source type, start/end time, duration, status.
- Login stage reached: `start`, `login_page`, `mfa_required`, `mfa_completed`, `portal_home`, `order_guide_opened`, `export_started`, `download_received`, `parsed`, `review_ready`, `approved`.
- Current URL host/path only, page title, visible heading text, HTTP response statuses for document navigations, redirect count.
- Screenshot and HTML snapshot on failure, stored in a private Storage path with retention.
- Row counts: downloaded rows, parsed rows, rows with price, rows missing SKU, duplicate SKUs, changed prices, suspicious changes.
- Error classification: `session_expired`, `mfa_required`, `captcha_or_bot_challenge`, `selector_changed`, `download_missing`, `parse_failed`, `empty_export`, `write_failed`, `rate_limited`, `vendor_outage`, `unknown`.

How to tell common causes apart:

- Session expired: redirect to login/identity provider, auth cookies missing/expired, portal home inaccessible, human re-login fixes it.
- MFA: login accepted but verification page appears; do not automate around it without vendor approval. Prefer interactive renewal or official feed.
- CAPTCHA/bot protection: challenge page, "unusual activity", blocked/403, browser fingerprint issues. Stop and alert; do not bypass.
- Site changed: auth works, export area loads, but selectors/headers no longer match; screenshots show normal page with moved controls.
- Hidden API changed: UI renders but old assumed response shape/header/CSV columns changed. Use exported files or official API, not private endpoints.
- JS data loading/pagination: visible count exceeds parsed count; scroll/page state needed; export/report route is safer than DOM cards.
- Rate limiting: 429/temporary blocked responses, failures after retries, recovery after cooldown.

Make errors easier to debug by converting free-text exceptions into classified `sync_errors` rows and linking each one to a stored screenshot, HTML snapshot, downloaded file, parsed header list, and parser version.

## 2. Safer Architecture

Use this pipeline:

1. Vendor source layer: official API, EDI, SFTP, scheduled report email, manual CSV/XLSX upload, or approved browser-export bridge.
2. Import layer: store raw file, detect vendor/report type, parse into staging rows, validate required fields.
3. Normalization layer: map vendor-specific SKUs/units/pack sizes to canonical item records.
4. Review layer: managers approve changes before vendor prices/orders/invoices affect the live cache.
5. DD Mau backend database: immutable orders/invoices/prices plus a small current-price cache for the staff app.
6. Staff app API/cache: staff app reads cached last-known prices only. It never logs into a vendor portal in real time.
7. Monitoring: sync logs, alerts, dead-man checks, suspicious price changes, duplicate detection.

In this repo, do not expand the current `vendor_prices/{vendor}.prices` map as the long-term store. Keep it only as a backwards-compatible cache while building normalized collections/tables.

## 3. Better Alternatives To Scraping

Ask each vendor rep for these, in this order:

- Sysco APIC/API access for account-specific catalog, order guide, order history, invoice, delivery, and pricing data.
- Sysco EDI or SFTP feeds for invoices/order acknowledgments/order guides. At minimum ask for 810 invoice and product/order-guide style exports.
- Sysco scheduled exports from Portal/Shop/Source if API/EDI is not available yet.
- US Foods MOXē Reporting CSV/XLSX exports: Detail Data, Product Usage, Invoice History.
- US Foods EDI/A2A/SFTP feeds if your account supports it.
- Scheduled email reports or invoice attachments from vendor billing/reporting systems.
- Manual upload as the guaranteed fallback.

Do not use private browser network endpoints unless the vendor documents and approves them.

## 4. MVP Plan

Phase 1 should be manual CSV/XLSX import, not a new scraper.

- Add an admin-only Vendor Imports screen.
- Manager selects vendor, account/location, import type: `order_guide`, `orders`, `invoice_history`, `product_usage`, `invoice_pdf`.
- Upload file to Storage, create `imports/{id}` with `status: uploaded`.
- Parse server-side into `import_rows/{id}` or `imports/{id}/rows/{rowId}`.
- Show preview: new items, changed prices, missing SKU/name/unit, suspicious changes, duplicate invoices/orders.
- Require admin approval before writing canonical item/order/invoice tables.
- Update a read-optimized current-price cache used by `Operations.jsx`.

## 5. Database Schema

For SaaS, use Postgres. For the current Firebase app, mirror these as Firestore collections with the same fields.

- `vendors`: `id`, `name`, `slug`, `status`, `created_at`.
- `vendor_accounts`: `id`, `vendor_id`, `account_number`, `display_name`, `status`, `credentials_ref`, `created_at`.
- `vendor_locations`: `id`, `vendor_account_id`, `location_key`, `vendor_customer_number`, `display_name`.
- `vendor_items`: `id`, `vendor_id`, `vendor_account_id`, `vendor_sku`, `name`, `brand`, `pack`, `size`, `unit`, `category`, `is_active`.
- `vendor_item_prices`: `id`, `vendor_item_id`, `vendor_location_id`, `price`, `price_unit`, `source`, `effective_at`, `import_id`, `approved_by`.
- `vendor_orders`: `id`, `vendor_id`, `vendor_location_id`, `vendor_order_number`, `ordered_at`, `delivery_date`, `status`, `total`.
- `vendor_order_lines`: `id`, `vendor_order_id`, `vendor_item_id`, `vendor_sku`, `description`, `qty_ordered`, `qty_shipped`, `unit_price`, `line_total`.
- `vendor_invoices`: `id`, `vendor_id`, `vendor_location_id`, `invoice_number`, `invoice_date`, `order_number`, `subtotal`, `tax`, `fees`, `total`.
- `vendor_invoice_lines`: `id`, `vendor_invoice_id`, `vendor_item_id`, `vendor_sku`, `description`, `qty`, `unit`, `unit_price`, `line_total`.
- `imports`: `id`, `vendor_id`, `vendor_location_id`, `type`, `file_path`, `file_hash`, `status`, `parser_version`, `created_by`, `approved_by`, `summary`.
- `import_rows`: `id`, `import_id`, `row_number`, `raw`, `normalized`, `status`, `errors`, `proposed_action`.
- `sync_jobs`: `id`, `vendor_id`, `vendor_location_id`, `source`, `status`, `started_at`, `finished_at`, `counts`, `artifact_paths`.
- `sync_errors`: `id`, `sync_job_id`, `classification`, `stage`, `message`, `artifact_paths`, `retryable`, `created_at`.
- `price_snapshots`: `id`, `vendor_item_id`, `vendor_location_id`, `price`, `observed_at`, `source`, `import_id`.
- `item_mappings`: `id`, `vendor_item_id`, `inventory_item_id`, `confidence`, `status`, `created_by`, `approved_by`.

## 6. API Endpoints

Use Cloud Functions or a separate backend service. Do not let anonymous clients approve vendor data directly.

- `POST /api/vendor-imports/upload-url`
- `POST /api/vendor-imports/:id/parse`
- `GET /api/vendor-imports/:id`
- `GET /api/vendor-imports/:id/rows`
- `POST /api/vendor-imports/:id/approve`
- `POST /api/vendor-imports/:id/reject`
- `GET /api/vendor-items/search?vendor=&q=&location=`
- `GET /api/vendor-items/:id/price-history`
- `GET /api/vendor-orders/recent?vendor=&location=`
- `GET /api/vendor-invoices?vendor=&location=&from=&to=`
- `POST /api/vendor-sync-jobs`
- `GET /api/vendor-sync-jobs`
- `GET /api/vendor-sync-jobs/:id/errors`

## 7. Temporary Scraper Bridge, Only If Allowed

Rules for a temporary bridge:

- Prefer portal CSV/XLSX export or reporting download over DOM product-card scraping.
- Do not bypass CAPTCHA, MFA, bot detection, rate limits, or access controls.
- Do not use stealth flags, anti-detection plugins, private API endpoint replay, or scraped CSRF tokens.
- Use explicit owner-approved session storage. Treat saved cookies like credentials.
- If MFA/CAPTCHA appears, stop, classify the error, alert admin, and fall back to manual upload.
- Capture screenshots/HTML/downloaded files on failure.
- Use parser contracts and column-header validation, not brittle string scraping.
- Never overwrite good prices with zero rows or unreviewed rows.
- Write `sync_jobs` and `sync_errors`; update current cache only after approval.

Safe adapter skeleton for Claude to implement in a separate backend worker:

```ts
import fs from 'node:fs';

type VendorExportResult = {
  ok: boolean;
  classification?: 'session_expired' | 'mfa_required' | 'captcha_or_bot_challenge' |
    'selector_changed' | 'download_missing' | 'parse_failed' | 'empty_export' | 'unknown';
  downloadedFilePath?: string;
  screenshotPath?: string;
  htmlPath?: string;
  message?: string;
};

export async function runApprovedPortalExport({ page, vendor, loginUrl, exportSteps, artifactsDir }): Promise<VendorExportResult> {
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (await page.getByText(/captcha|verify you are human|unusual activity/i).count()) {
    return { ok: false, classification: 'captcha_or_bot_challenge', message: 'Security challenge shown; manual import required.' };
  }
  if (await page.getByText(/verification code|multi-factor|authenticator|email code/i).count()) {
    return { ok: false, classification: 'mfa_required', message: 'MFA required; do not bypass. Renew session interactively or use manual export.' };
  }

  try {
    for (const step of exportSteps) await step(page);
    const download = await page.waitForEvent('download', { timeout: 30000 });
    const path = `${artifactsDir}/${vendor}-${Date.now()}-${download.suggestedFilename()}`;
    await download.saveAs(path);
    return { ok: true, downloadedFilePath: path };
  } catch (err) {
    const screenshotPath = `${artifactsDir}/${vendor}-${Date.now()}.png`;
    const htmlPath = `${artifactsDir}/${vendor}-${Date.now()}.html`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    await fs.promises.writeFile(htmlPath, await page.content()).catch(() => {});
    return { ok: false, classification: 'selector_changed', screenshotPath, htmlPath, message: String(err) };
  }
}
```

## 8. Monitoring

Add a Vendor Sync Health panel:

- Last successful sync by vendor/location/import type.
- Last attempt and current status.
- Items imported, prices changed, rows rejected.
- Missing required fields and parse warnings.
- Suspicious price changes: default threshold 25 percent or absolute $20.
- Duplicate invoice/order numbers.
- Count of item mappings needing review.
- Alerts to Slack/email when a sync fails, has zero rows, has high suspicious-change count, or has not succeeded in 48 hours.

## 9. Staff App Behavior

The staff app should read only cached data. Rename "LIVE" labels in `Operations.jsx` to "last known" or "vendor cache" because these are not real-time prices.

Display:

- `Sysco $42.95, last updated Jan 12, 8:35 AM`
- `US Foods $44.10, last invoice Jan 10`
- `Sync failed Jan 13, showing last-known price`

Never block inventory/prep ordering because a vendor sync failed.

## 10. Implementation Plan For Claude

Phase 1: Manual CSV/XLSX imports

- Add parser library with vendor-specific header mapping.
- Add Storage upload + import records.
- Add Admin review UI.
- Keep writing `vendor_prices/{vendor}` cache for existing `Operations.jsx` compatibility.

Phase 2: Invoice/order history imports

- Add invoice/order parsers and duplicate detection.
- Build `current price`, `last ordered price`, and `last invoice price` views.
- Add item-mapping review workflow.

Phase 3: Official integrations

- Request Sysco APIC/API access.
- Request Sysco/US Foods EDI or SFTP feeds.
- Implement each vendor as an adapter that writes the same import staging tables.

Phase 4: Optional monitored portal export

- Only with vendor/account approval.
- Export files through documented UI/reporting screens.
- Stop on MFA/CAPTCHA/security challenges.
- Log artifacts and fall back to manual upload.

Phase 5: Price alerts and recipe costing

- Snapshot every approved price.
- Alert on unusual increases.
- Feed recipe costing from approved vendor item mappings.

## Concrete Changes I Would Make In This Repo

- Add `VendorImports.jsx` instead of adding more scraper controls to the giant `Operations.jsx`.
- Add a backend import parser rather than client-only Firestore writes, because current Firestore access is anonymous and client-gated.
- Replace single-doc price maps with normalized collections, but keep the current docs as read caches during migration.
- Rename "LIVE" in inventory UI to "Last known" or "Cached".
- Stop using Gmail IMAP 2FA as the primary integration strategy. It is a fragile temporary bridge, not the system of record.
- Remove/avoid stealth-style browser flags in scraper workers. If a vendor blocks automation, the answer is official feed/manual import, not evasion.
- Remove AI navigation/recovery from production scraper flow. It makes failures harder to reproduce and can click the wrong thing in a purchasing portal.
