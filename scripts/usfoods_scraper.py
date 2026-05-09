#!/usr/bin/env python3
"""
DD Mau — US Foods Price Scraper (module)
=========================================
Logs into US Foods, handles email-based 2FA via Gmail IMAP,
scrapes the Order Guide (My Lists → DD Mau Orderguide) for current prices.
Called once daily from the main scraper loop.

v4 — updated navigation to match real site flow (standard HTML, not Ionic).

Environment variables:
  USFOODS_USERNAME          — US Foods username (ddmaustl)
  USFOODS_GMAIL             — Gmail address that receives the 2FA code
  USFOODS_GMAIL_APP_PASSWORD — Gmail App Password for IMAP access
"""

import re
import os
import time
import imaplib
import email
import traceback
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

from playwright.sync_api import sync_playwright, TimeoutError as PwTimeout

# AI-powered recovery (gracefully degrades if ANTHROPIC_API_KEY not set)
try:
    from ai_helpers import ai_recover, ai_navigate_to_goal, ai_extract_data
except ImportError:
    ai_recover = ai_navigate_to_goal = ai_extract_data = None

# Central Time zone — handles CST/CDT switchover automatically. The old
# implementation hard-coded `timezone(timedelta(hours=-5))` which is only
# correct during DST (CDT). After DST ends in November, that fixed offset
# is one hour ahead of actual Central Time, which would shift every
# timestamp written to vendor_prices/usfoods_status by an hour and the
# daily-rerun gate (which compares date strings derived from this
# timestamp) could fire on the wrong calendar day.
_CT = ZoneInfo("America/Chicago")


# ── Constants ────────────────────────────────────────────────────────────────
MAX_LOGIN_RETRIES = 2
SCROLL_PAUSE_SEC = 1.5
MAX_SCROLL_ATTEMPTS = 80
STABLE_SCROLLS_BEFORE_STOP = 6
PAGE_LOAD_WAIT_SEC = 10
CODE_POLL_ATTEMPTS = 20
CODE_POLL_INTERVAL = 5
CODE_MAX_AGE_SEC = 120  # Hard cap — emails older than 2 min cannot be the
                        # code we just requested. Combined with the
                        # request_time gate below, this prevents any chance
                        # of using a stale code from a prior attempt.


def _log(msg):
    ct = datetime.now(_CT)
    print(f"[{ct.strftime('%H:%M:%S')}] [USFOODS] {msg}", flush=True)


def _ct_now():
    return datetime.now(_CT)


# ── Robust 6-digit code extractor ──────────────────────────────────────────
def _extract_2fa_code(text):
    """Pull a 6-digit verification code from email text.

    Robust to template boilerplate that contains other 6-digit numbers
    (account refs, customer IDs, tracking codes, image filenames). Discovered
    on 2026-05-01 that the US Foods MOXē email template contains a static
    "767676" string somewhere before the actual code, which a naive
    `\\b(\\d{6})\\b` matcher picks up first.

    Strategy (in priority order):
      1. Code immediately following an explicit verification-code keyword
         like "Please use the code below", "Your verification code is", etc.
      2. A 6-digit number on its own line whose surrounding lines mention
         "code" / "verification".
      3. As a last resort, the first 6-digit number that does NOT match
         a template-constant pattern (XXXXXX, XYXYXY, XXYYZZ, AABBCC).
    Returns None if nothing plausible is found.
    """
    if not text:
        return None

    # Strategy 1: keyword-anchored
    keyword_patterns = [
        r'verification\s+code[\s:.\n\-]*?(\d{6})\b',
        r'(?:use|enter)\s+(?:the\s+|this\s+)?code[\s:.\n][\s\S]{0,80}?(\d{6})\b',
        r'code\s+(?:is|below|to\s+verify)[\s:.\n][\s\S]{0,80}?(\d{6})\b',
        r'your\s+code[\s:.\n][\s\S]{0,40}?(\d{6})\b',
        r'one[\s\-]?time\s+(?:code|password|passcode)[\s:.\n][\s\S]{0,40}?(\d{6})\b',
        r'security\s+code[\s:.\n][\s\S]{0,40}?(\d{6})\b',
        r'access\s+code[\s:.\n][\s\S]{0,40}?(\d{6})\b',
    ]
    for p in keyword_patterns:
        m = re.search(p, text, re.IGNORECASE | re.DOTALL)
        if m:
            return m.group(1)

    # Strategy 2: 6-digit number alone on a line near a code keyword
    lines = text.split('\n')
    for i, line in enumerate(lines):
        m = re.match(r'^\s*(\d{6})\s*$', line)
        if not m:
            continue
        ctx = ' '.join(lines[max(0, i - 4):i + 4]).lower()
        if any(kw in ctx for kw in ['code', 'verif', 'security', 'one-time', 'otp', 'login']):
            return m.group(1)

    # Strategy 3: first non-template 6-digit number
    def is_template_constant(s):
        # All same digit (000000, 111111)
        if s == s[0] * 6:
            return True
        # XYXYXY pattern (767676, 121212)
        if s[0:2] == s[2:4] == s[4:6]:
            return True
        # XXYYZZ pattern (112233)
        if s[0] == s[1] and s[2] == s[3] and s[4] == s[5]:
            return True
        # ABCABC pattern (123123)
        if s[0:3] == s[3:6]:
            return True
        # Sequential ascending or descending (123456, 654321)
        digs = [int(c) for c in s]
        if all(digs[i] - digs[i - 1] == 1 for i in range(1, 6)):
            return True
        if all(digs[i - 1] - digs[i] == 1 for i in range(1, 6)):
            return True
        return False

    for m in re.finditer(r'\b(\d{6})\b', text):
        candidate = m.group(1)
        if is_template_constant(candidate):
            continue
        return candidate
    # Last-ditch — return any 6-digit number even if it looks template-y
    for m in re.finditer(r'\b(\d{6})\b', text):
        return m.group(1)
    return None


# ── Firestore status helpers ────────────────────────────────────────────────
def _write_scrape_status(db, status, detail="", prices_count=0):
    try:
        from firebase_admin import firestore as fs
        doc_ref = db.collection("vendor_prices").document("usfoods_status")
        data = {
            "status": status,
            "detail": detail[:500],
            "pricesFound": prices_count,
            "updatedAt": _ct_now().isoformat(),
            "timestamp": fs.SERVER_TIMESTAMP,
        }
        doc_ref.set(data)
        _log(f"  [Status] {status}: {detail[:100]}")
    except Exception as e:
        _log(f"  [Status] Failed to write status: {e}")


# ── Gmail IMAP — fetch 2FA verification code ────────────────────────────────
def _fetch_2fa_code_from_gmail(gmail_address, gmail_app_password,
                                min_arrival_time=None):
    """Find the latest US Foods verification email and return the 6-digit
    code. CRITICAL: must filter by recency, otherwise stale codes from
    earlier login attempts get re-used (on 2026-05-01 the scraper kept
    submitting 767676 from a morning attempt instead of the fresh code
    that had just arrived).

    Strategy:
      1. Restrict the IMAP search to emails received TODAY (SINCE filter).
      2. Sort matching messages newest-first by parsed Date header.
      3. REJECT any email received before `min_arrival_time` if provided
         — this is the absolute gate. The caller passes the time they
         clicked the "Email" button, so codes that existed before that
         click cannot be used.
      4. Also reject any email older than CODE_MAX_AGE_SEC as a backup
         guarantee.
      5. Return the first 6-digit number found in the freshest match.
    """
    from email.utils import parsedate_to_datetime
    _log("  Checking Gmail for US Foods verification code...")
    try:
        mail = imaplib.IMAP4_SSL("imap.gmail.com")
        mail.login(gmail_address, gmail_app_password)
        mail.select("inbox")

        # SINCE filter — limit search to emails received today (Central Time).
        # CRITICAL FIX: previously used UTC for the SINCE date. After ~6 PM CDT
        # (= midnight UTC), UTC rolls to the NEXT day, so
        # `SINCE "02-May-2026"` would exclude emails that arrived on May 1st
        # CDT — which is exactly when the verification code lands. Now we use
        # CT to compute the date, and subtract 1 day as extra safety margin
        # since IMAP SINCE is date-only (no time component) and Gmail's date
        # boundaries can be fuzzy across timezones.
        today_ct = datetime.now(_CT)
        since_date = today_ct - timedelta(days=1)
        since_str = since_date.strftime("%d-%b-%Y")
        status, msg_ids = mail.search(None, f'(SINCE "{since_str}")')
        if status != "OK" or not msg_ids[0]:
            _log("  No emails received today — nothing to check")
            mail.logout()
            return None

        # Fetch headers for all candidates so we can sort by Date
        # (IMAP IDs aren't always strictly chronological — Gmail
        # threads in particular can interleave). We pull only the Date
        # header here to keep this cheap, then re-fetch full body for
        # the freshest one.
        candidates = []  # [(datetime, msg_id), ...]
        for raw_id in msg_ids[0].split()[-25:]:  # cap at 25 most-recent IDs
            try:
                hstatus, hdata = mail.fetch(raw_id, "(BODY.PEEK[HEADER.FIELDS (DATE FROM SUBJECT)])")
                if hstatus != "OK" or not hdata or not hdata[0]:
                    continue
                hdr = email.message_from_bytes(hdata[0][1])
                date_hdr = hdr.get("Date")
                if not date_hdr:
                    continue
                try:
                    dt = parsedate_to_datetime(date_hdr)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=timezone.utc)
                except Exception:
                    continue
                candidates.append((dt, raw_id, hdr.get("From", ""), hdr.get("Subject", "")))
            except Exception:
                continue

        # Sort newest-first
        candidates.sort(key=lambda t: t[0], reverse=True)

        now_utc = datetime.now(timezone.utc)
        for dt, msg_id, from_hdr, subj_hdr in candidates:
            age_sec = (now_utc - dt).total_seconds()
            # ABSOLUTE GATE: only accept emails that arrived AFTER we
            # requested the code. This is the bulletproof part — if the
            # email predates the click, it can't be the code we just
            # requested. No exceptions.
            if min_arrival_time is not None and dt < min_arrival_time:
                _log(f"    Rejecting email from {dt.isoformat()} — predates "
                     f"code request at {min_arrival_time.isoformat()} "
                     f"subj={subj_hdr.strip()[:60]!r}")
                # Sorted newest-first; everything else is also older
                break
            if age_sec > CODE_MAX_AGE_SEC:
                _log(f"    Skipping email from {dt.isoformat()} "
                     f"(age={int(age_sec)}s > {CODE_MAX_AGE_SEC}s) "
                     f"subj={subj_hdr.strip()[:60]!r}")
                # Older candidates in the sorted list are even older — stop
                break
            # Recent enough — fetch full body and try to extract code.
            status, msg_data = mail.fetch(msg_id, "(RFC822)")
            if status != "OK":
                continue

            msg = email.message_from_bytes(msg_data[0][1])
            from_addr = (msg.get("From") or "").lower()
            subject = (msg.get("Subject") or "").lower()

            is_usfoods = any(kw in from_addr for kw in ["usfoods", "us foods", "usfood"])
            is_verification = any(kw in subject for kw in ["verif", "code", "security", "sign", "login", "one-time", "otp"])

            body = ""
            if msg.is_multipart():
                for part in msg.walk():
                    content_type = part.get_content_type()
                    if content_type in ("text/plain", "text/html"):
                        try:
                            body += part.get_payload(decode=True).decode("utf-8", errors="replace")
                        except Exception:
                            pass
            else:
                try:
                    body = msg.get_payload(decode=True).decode("utf-8", errors="replace")
                except Exception:
                    body = str(msg.get_payload())

            # Filter in Python (cheaper and more reliable than complex
            # IMAP OR queries). Skip emails that aren't from US Foods AND
            # don't have a verification subject — anything else can't be
            # the code we're after.
            if not (is_usfoods or is_verification):
                continue

            # Strip HTML tags before extracting — they can contain numeric
            # IDs (image src, tracking pixels, css classes) that confuse
            # the regex. Keep newlines.
            body_stripped = re.sub(r'<[^>]+>', ' ', body)
            body_stripped = re.sub(r'&nbsp;|&#160;', ' ', body_stripped)
            body_stripped = re.sub(r'&[a-z]+;|&#\d+;', ' ', body_stripped)
            full_text = subject + "\n" + body_stripped

            code = _extract_2fa_code(full_text)
            if code:
                _log(f"  Found verification code: {code} "
                     f"(from: {from_addr[:50]}, age={int(age_sec)}s)")
                mail.store(msg_id, '+FLAGS', '\\Seen')
                mail.logout()
                return code

        _log("  No fresh verification code found")
        mail.logout()
        return None
    except Exception as e:
        _log(f"  Gmail IMAP error: {e}")
        # IMPORTANT: ensure the IMAP connection is closed even on the exception
        # path. This function is called up to CODE_POLL_ATTEMPTS=20 times per
        # 2FA attempt; without this cleanup, every retry that raises after a
        # successful login() leaks one authenticated connection. Gmail's
        # concurrent IMAP cap (~15) would then block the entire daily US Foods
        # scrape. `mail` may be unbound if `imaplib.IMAP4_SSL(...)` itself
        # raised — the inner try/except (NameError ⊂ Exception) handles that.
        try:
            mail.logout()
        except Exception:
            pass
        return None


def _wait_for_2fa_code(gmail_address, gmail_app_password, request_time=None):
    """Poll Gmail for a fresh 2FA code. `request_time` should be the UTC
    time at which the scraper clicked the "Email" button; only emails that
    arrive AFTER this timestamp are accepted, which guarantees we can't
    re-use a code from a prior attempt. If not provided, defaults to
    "30 seconds before this call started" (a safety margin for clock
    drift between Gmail's servers and ours)."""
    if request_time is None:
        request_time = datetime.now(timezone.utc) - timedelta(seconds=30)
    _log(f"  Code request gate: only accepting emails newer than "
         f"{request_time.isoformat()}")
    for attempt in range(CODE_POLL_ATTEMPTS):
        code = _fetch_2fa_code_from_gmail(
            gmail_address, gmail_app_password,
            min_arrival_time=request_time,
        )
        if code:
            return code
        _log(f"  Waiting for code... (attempt {attempt + 1}/{CODE_POLL_ATTEMPTS})")
        time.sleep(CODE_POLL_INTERVAL)
    _log("  FAILED: Never received verification code from Gmail")
    return None


# ── Playwright helpers ──────────────────────────────────────────────────────
def _find_input(page, selectors, label="input"):
    for sel in selectors:
        try:
            el = page.query_selector(sel)
            if el and el.is_visible():
                _log(f"  Found {label}: {sel}")
                return el
        except Exception:
            pass
    return None


def _safe_fill(page, element, text):
    try:
        element.click(timeout=5000)
        time.sleep(0.3)
    except Exception:
        try:
            element.focus()
            time.sleep(0.3)
        except Exception:
            pass
    page.keyboard.press("Control+a")
    time.sleep(0.1)
    page.keyboard.type(text, delay=60)
    time.sleep(0.3)


def _safe_click(page, selectors, label="button"):
    for sel in selectors:
        try:
            el = page.query_selector(sel)
            if el and el.is_visible():
                el.click(timeout=5000)
                _log(f"  Clicked {label}: {sel}")
                return True
        except Exception:
            continue
    return False


def _dismiss_popups(page):
    dismiss_selectors = [
        'button:has-text("Accept")', 'button:has-text("Got it")',
        'button:has-text("Close")', 'button:has-text("OK")',
        '[class*="cookie"] button', '[class*="consent"] button',
        '[aria-label="Close"]', 'button:has-text("Dismiss")',
        'button:has-text("I understand")', 'button:has-text("Continue")',
        'button:has-text("No thanks")', 'button:has-text("Not now")',
    ]
    for sel in dismiss_selectors:
        try:
            btn = page.query_selector(sel)
            if btn and btn.is_visible():
                btn.click()
                time.sleep(0.5)
                _log(f"  Dismissed popup: {sel}")
                break
        except Exception:
            pass


def _is_logged_in(page):
    """URL-PATH-based check. Inspects the URL path only (not the full URL),
    so the hostname `order.usfoods.com` does NOT trip substring matches like
    `"/order"` (which is what was happening: `https://order.usfoods.com/login`
    contains the substring `/order` because `//order...` matches at the
    double slash, and the old check returned True even on the login page).

    Prefer _verify_authenticated() which adds a DOM-based check on top of
    this. _is_logged_in is kept as a cheap fallback when DOM inspection
    fails (e.g., page in a transient state)."""
    try:
        from urllib.parse import urlparse
        parsed = urlparse(page.url)
        host = (parsed.hostname or '').lower()
        path = (parsed.path or '/').lower()
    except Exception:
        return False

    if 'usfoods.com' not in host:
        return False
    # Login / auth paths are explicit negatives — no false positives via host.
    if path.startswith('/login') or path.startswith('/signin') or path.startswith('/auth'):
        return False
    # Authenticated path prefixes (paths only, not host).
    auth_prefixes = ('/desktop', '/shop', '/orders', '/lists', '/history', '/home', '/account')
    return any(path.startswith(p) for p in auth_prefixes)


def _verify_authenticated(page):
    """DOM-based auth check.

    HISTORY OF FALSE POSITIVES (2026-05-01):
      • Original URL-only check returned True at /login because the URL
        contains substring "/order" via the //order.usfoods.com hostname.
      • DOM check then started returning True at the marketing page
        /desktop/search/browse because the nav has a "My Lists" link
        inside the "My Business" dropdown — which exists on the
        anonymous marketing page too. The weak positive selectors
        `a:has-text("My Lists")` and `a[href*="/desktop/lists"]` matched
        even when logged out.

    The current rule: an authenticated session shows EITHER a clear
    sign-out affordance OR has no "Become A Customer" + "Log In" CTAs.
    The marketing/anonymous page has BOTH the My Lists nav link AND
    the Become A Customer CTA — so we trust only the strong signals.
    """
    from urllib.parse import urlparse

    # Cheap URL prefilter
    url = page.url.lower()
    if "login" in url or "signin" in url or "/auth" in url:
        return False

    try:
        path = (urlparse(page.url).path or '').lower()
    except Exception:
        path = ''

    # Path-level negative — /desktop/search/browse is the anonymous
    # marketing redirect target. Landing here means we're NOT authenticated
    # (URL doesn't contain "login" but it's still the public catalog).
    if path.startswith('/desktop/search/browse'):
        return False

    # Path-level POSITIVE — these paths are unreachable when logged out.
    # An anonymous user hitting /desktop/home gets bounced to /search/browse,
    # so if we landed on /desktop/home and stayed, we're authenticated.
    # Same for /desktop/lists, /desktop/orders, /desktop/account etc.
    if (path.startswith('/desktop/home')
            or path.startswith('/desktop/lists')
            or path.startswith('/desktop/orders')
            or path.startswith('/desktop/account')
            or path.startswith('/desktop/checkout')
            or path.startswith('/desktop/order-history')):
        # But still confirm with a body check — Ionic SPAs can briefly
        # render an empty shell with the right URL.
        try:
            body_text = (page.inner_text('body') or '')[:8000].lower()
            if 'become a customer' in body_text:
                # If marketing CTA is visible we got bounced after all.
                return False
            # "My Lists", "My Deals", "Browse Products" together signal
            # the logged-in dashboard.
            authenticated_signals = ['my lists', 'my deals', 'browse products',
                                     'order history', 'my orders',
                                     'farmers report', 'core essentials']
            hits = sum(1 for s in authenticated_signals if s in body_text)
            if hits >= 2:
                return True
        except Exception:
            pass
        # Path itself is strong enough on US Foods — trust it
        return True

    try:
        body_text = (page.inner_text('body') or '')[:8000].lower()

        # Hard negatives — any of these means logged out
        if 'become a customer' in body_text:
            return False
        if "i'm ready to get started" in body_text or 'ready to get started' in body_text:
            return False

        # Strong positives — sign-out affordances
        strong_positive_selectors = [
            'a:has-text("Sign Out")', 'button:has-text("Sign Out")',
            'a:has-text("Log Out")', 'button:has-text("Log Out")',
            '[data-cy*="signout"]', '[data-cy*="logout"]',
            '[aria-label*="sign out" i]', '[aria-label*="log out" i]',
            'a:has-text("My Account")', 'button:has-text("My Account")',
        ]
        for sel in strong_positive_selectors:
            try:
                el = page.query_selector(sel)
                if el and el.is_visible():
                    return True
            except Exception:
                continue

        # Body-text positive: "sign out" or "welcome back, ..." substring
        if 'sign out' in body_text or 'welcome back' in body_text:
            return True
    except Exception:
        pass

    return False


# ── SPA helpers ─────────────────────────────────────────────────────────────
def _wait_for_page_render(page, label=""):
    """Wait for the US Foods page to finish rendering (standard Angular site)."""
    prefix = f"  [{label}] " if label else "  "
    try:
        page.wait_for_load_state("networkidle", timeout=25000)
    except Exception:
        _log(f"{prefix}networkidle timed out — continuing")
    page_selectors = [
        '[data-cy="pme-product-card"]', '.usf-pme-product-card',
        '[class*="product-card"]', '[class*="ProductCard"]',
        'a[href*="/lists/view/"]', 'a[href*="/lists"]',
        '[class*="product"]', '[class*="list-name"]',
        'nav', 'main', 'header',
    ]
    for sel in page_selectors:
        try:
            page.wait_for_selector(sel, timeout=8000)
            _log(f"{prefix}Page rendered — found: {sel}")
            return True
        except Exception:
            continue
    time.sleep(5)
    return False


def _log_all_links(page, label=""):
    """Log ALL links on the page — critical for finding the order guide."""
    try:
        links = page.evaluate("""
        () => {
            const result = [];
            document.querySelectorAll('a').forEach(el => {
                const text = (el.innerText || '').trim().substring(0, 80);
                const href = (el.href || '').substring(0, 150);
                if (text || href) result.push({ text, href });
            });
            return result;
        }
        """)
        prefix = f"  [{label}] " if label else "  "
        _log(f"{prefix}ALL LINKS ({len(links)} total):")
        for lnk in links:
            _log(f"{prefix}  '{lnk['text']}' → {lnk['href']}")
    except Exception as e:
        _log(f"  Link logging error: {e}")


def _log_page_elements(page, label=""):
    """Log all interactive elements on the page for debugging."""
    try:
        elements = page.evaluate("""
        () => {
            const result = { inputs: [], buttons: [] };
            document.querySelectorAll('input').forEach(el => {
                if (el.offsetParent !== null) {
                    result.inputs.push({
                        type: el.type, name: el.name, id: el.id,
                        placeholder: el.placeholder,
                        ariaLabel: el.getAttribute('aria-label')
                    });
                }
            });
            document.querySelectorAll('button').forEach(el => {
                if (el.offsetParent !== null) {
                    result.buttons.push(el.innerText.trim().substring(0, 60));
                }
            });
            return result;
        }
        """)
        prefix = f"  [{label}] " if label else "  "
        if elements.get('inputs'):
            for inp in elements['inputs'][:10]:
                _log(f"{prefix}INPUT: type={inp['type']} name={inp['name']} placeholder={inp['placeholder']}")
        if elements.get('buttons'):
            _log(f"{prefix}BUTTONS: {elements['buttons'][:15]}")
    except Exception as e:
        _log(f"  Element logging error: {e}")


# ── Login with 2FA ──────────────────────────────────────────────────────────
def _login(page, username, gmail_address, gmail_app_password):
    _log("Navigating to US Foods login...")

    try:
        page.goto("https://order.usfoods.com/login", wait_until="networkidle", timeout=30000)
        _log(f"  Loaded: {page.url}")
        time.sleep(3)
        _dismiss_popups(page)
    except Exception as e:
        _log(f"  Failed to load login page: {e}")

    # Use DOM-based check, not URL-only. The old _is_logged_in() returned True
    # at the literal /login page because the URL contains the substring
    # "/order" via the //order.usfoods.com hostname — a false positive that
    # caused the entire 2FA flow (including the "Stay signed in?" handler) to
    # be skipped and the scraper to proceed with an unauthenticated session.
    if _verify_authenticated(page):
        _log("  Already logged in (DOM-verified)!")
        return True
    _log("  Not yet authenticated — proceeding with login flow")

    # ── Step 0 (NEW 2026-05-01): Click the top-right "Log In" button to
    # initiate the Azure AD B2C OAuth flow.
    #
    # Background: US Foods migrated their authentication to Azure AD B2C.
    # Hitting `/login` directly now redirects to a marketing landing page at
    # `/desktop/search/browse` with two CTAs in the header — "Become A
    # Customer" and "Log In". The actual login form lives on
    # `usfoodsb2cprod.b2clogin.com` and is reached only by clicking that
    # "Log In" button (which generates the OAuth authorize request with
    # client_id, redirect_uri, etc. — we can't hard-code that URL because
    # the params include nonces/timestamps).
    if 'usfoods.com' in page.url and 'b2clogin.com' not in page.url:
        _log("  Looking for top-right 'Log In' button to start B2C flow...")
        # The landing page (order.usfoods.com/desktop/search/browse) uses
        # Ionic Web Components (ion-button, ion-header, etc.). These render
        # their content inside Shadow DOM, which means:
        #   - page.query_selector(':has-text(...)') CANNOT see text inside shadows
        #   - document.querySelectorAll('*') CANNOT traverse shadow roots
        #   - Playwright's page.locator() API DOES auto-pierce shadow DOM
        # Additionally, Ionic apps are SPAs that need hydration time — the
        # ion-button may not exist in the DOM until the Angular/Stencil app
        # boots (10-30+ seconds on slow connections).

        # ── Phase 1: Wait for Ionic app to hydrate (up to 45 seconds) ──
        _log("  Waiting for Ionic app to hydrate...")
        login_button_clicked = False
        for wait_attempt in range(15):  # 15 × 3s = 45 seconds max
            # Method A: Playwright locator (auto-pierces shadow DOM)
            # Try multiple locator strategies that Playwright can resolve
            try:
                # ion-button with "Log In" text (Playwright pierces shadow DOM)
                loc = page.locator('ion-button:has-text("Log In")').first
                if loc.count() > 0 and loc.is_visible(timeout=1000):
                    loc.click(timeout=5000)
                    _log(f"  Clicked ion-button via Playwright locator (attempt {wait_attempt+1})")
                    login_button_clicked = True
                    break
            except Exception:
                pass

            try:
                loc = page.locator('ion-button:has-text("Login")').first
                if loc.count() > 0 and loc.is_visible(timeout=1000):
                    loc.click(timeout=5000)
                    _log(f"  Clicked ion-button 'Login' via Playwright locator (attempt {wait_attempt+1})")
                    login_button_clicked = True
                    break
            except Exception:
                pass

            # Method B: Standard selectors (for non-Ionic fallback)
            for sel in ['a[href*="b2clogin"]',
                        'a:has-text("Log In")', 'button:has-text("Log In")',
                        'a:has-text("Sign In")', 'button:has-text("Sign In")']:
                try:
                    el = page.query_selector(sel)
                    if el and el.is_visible():
                        el.click(timeout=5000)
                        _log(f"  Clicked login via selector: {sel} (attempt {wait_attempt+1})")
                        login_button_clicked = True
                        break
                except Exception:
                    continue
            if login_button_clicked:
                break

            # Method C: Playwright generic text locator (pierces shadow DOM)
            for txt in ['Log In', 'Login', 'Sign In']:
                try:
                    loc = page.locator(f'text="{txt}"').first
                    if loc.is_visible(timeout=1000):
                        loc.click(timeout=5000)
                        _log(f"  Clicked via text locator '{txt}' (attempt {wait_attempt+1})")
                        login_button_clicked = True
                        break
                except Exception:
                    continue
            if login_button_clicked:
                break

            # Not found yet — log status and wait
            if wait_attempt < 14:
                try:
                    ion_buttons = page.locator('ion-button').count()
                    _log(f"  Hydration wait {wait_attempt+1}/15: "
                         f"{ion_buttons} ion-button(s) in DOM, "
                         f"URL={page.url[-60:]}")
                except Exception:
                    _log(f"  Hydration wait {wait_attempt+1}/15...")
                time.sleep(3)

        # ── Phase 2: JS shadow DOM traversal fallback ──
        if not login_button_clicked:
            _log("  Trying JS shadow DOM traversal fallback...")
            try:
                clicked = page.evaluate("""
                () => {
                    const want = ['log in', 'login', 'sign in'];

                    // Helper: recursively collect all elements including shadow DOM
                    function walkAll(root, results) {
                        const children = root.querySelectorAll('*');
                        for (const el of children) {
                            results.push(el);
                            if (el.shadowRoot) {
                                walkAll(el.shadowRoot, results);
                            }
                        }
                        return results;
                    }

                    const allEls = walkAll(document, []);
                    for (const el of allEls) {
                        const t = (el.textContent || '').trim().toLowerCase();
                        if (!want.includes(t)) continue;
                        const tag = el.tagName.toLowerCase();
                        // Click if it's a button-like element
                        if (tag === 'a' || tag === 'button' ||
                            tag === 'ion-button' ||
                            el.getAttribute('role') === 'button' ||
                            el.onclick != null) {
                            el.click();
                            return { tag: tag, text: t, shadow: true };
                        }
                        // Walk up to find clickable ancestor
                        let p = el.parentElement || (el.getRootNode && el.getRootNode().host);
                        for (let d = 0; d < 5 && p; d++) {
                            const pt = p.tagName.toLowerCase();
                            if (pt === 'button' || pt === 'a' ||
                                pt === 'ion-button' ||
                                p.getAttribute('role') === 'button') {
                                p.click();
                                return { tag: pt, text: t, viaAncestor: true, shadow: true };
                            }
                            p = p.parentElement || (p.getRootNode && p.getRootNode().host);
                        }
                    }
                    return null;
                }
                """)
                if clicked:
                    _log(f"  Clicked 'Log In' via JS shadow DOM walk: <{clicked['tag']}> "
                         f"text='{clicked['text']}' "
                         f"viaAncestor={clicked.get('viaAncestor', False)}")
                    login_button_clicked = True
            except Exception as e:
                _log(f"  JS shadow DOM click error: {e}")

        if login_button_clicked:
            # Wait for the OAuth redirect to b2clogin.com to land.
            try:
                page.wait_for_url("**b2clogin.com**", timeout=20000)
                _log(f"  Redirected to B2C: {page.url[:120]}")
            except Exception:
                _log(f"  No b2clogin redirect detected within 20s — "
                     f"current URL: {page.url[:120]}")
            time.sleep(3)
            _dismiss_popups(page)
        else:
            _log("  WARNING: Could not click 'Log In' button — login form "
                 "may not be reachable")

    for attempt in range(MAX_LOGIN_RETRIES):
        _log(f"  Login attempt {attempt + 1}/{MAX_LOGIN_RETRIES}")

        # Step 1: Enter username (Azure B2C "User ID" field)
        # The form is now Azure AD B2C. The standard input name is
        # `signInName` and the visible label is "User ID" (placeholder
        # "User ID" too). Old usfoods.com selectors are kept as fallbacks
        # in case the page is rendered differently for some accounts.
        username_selectors = [
            # Azure B2C standard
            'input[name="signInName"]', 'input[id="signInName"]',
            'input[placeholder="User ID"]', 'input[placeholder*="User ID" i]',
            'input[aria-label*="User ID" i]',
            # Generic email-style
            'input[type="email"]', 'input[name="email"]',
            'input[id="email"]', 'input[autocomplete="email"]',
            'input[autocomplete="username"]',
            'input[name="username"]', 'input[name="userId"]',
            'input[name="user"]', 'input[name="loginId"]',
            'input[id="username"]', 'input[id="userId"]',
            'input[id*="user" i]', 'input[id*="email" i]',
            'input[name*="user" i]', 'input[name*="email" i]',
            'input[placeholder*="user" i]', 'input[placeholder*="email" i]',
            'input[aria-label*="user" i]', 'input[aria-label*="email" i]',
            'input[type="text"]',
        ]
        username_input = _find_input(page, username_selectors, "username")
        if not username_input:
            time.sleep(3)
            _dismiss_popups(page)
            username_input = _find_input(page, username_selectors, "username (retry)")

        # Fallback: try inside any iframes on the page (some IdP-hosted forms
        # render inside an iframe, in which case page.query_selector misses
        # them entirely).
        if not username_input:
            try:
                for fr in page.frames:
                    if fr == page.main_frame:
                        continue
                    for sel in username_selectors:
                        try:
                            el = fr.query_selector(sel)
                            if el and el.is_visible():
                                _log(f"  Found username inside iframe: {fr.url[:80]} via {sel}")
                                username_input = el
                                break
                        except Exception:
                            continue
                    if username_input:
                        break
            except Exception as e:
                _log(f"  iframe scan error: {e}")

        if not username_input:
            # Diagnostic dump — list every input on the page so next log
            # iteration tells us exactly what selector to add. Without this,
            # "FATAL: No username input found" gives no actionable info.
            try:
                input_dump = page.evaluate("""
                () => {
                    const inputs = document.querySelectorAll('input');
                    return Array.from(inputs).slice(0, 20).map(el => ({
                        type: el.type || '',
                        name: el.name || '',
                        id: el.id || '',
                        placeholder: el.placeholder || '',
                        ariaLabel: el.getAttribute('aria-label') || '',
                        autocomplete: el.autocomplete || '',
                        visible: el.offsetParent !== null,
                    }));
                }
                """)
                _log(f"  DIAGNOSTIC: Found {len(input_dump)} <input> elements on page:")
                for i, inp in enumerate(input_dump):
                    _log(f"    [{i}] type={inp['type']!r} name={inp['name']!r} "
                         f"id={inp['id']!r} ph={inp['placeholder']!r} "
                         f"aria={inp['ariaLabel']!r} ac={inp['autocomplete']!r} "
                         f"visible={inp['visible']}")
                # Also dump iframe URLs for visibility
                try:
                    frames = [f.url[:80] for f in page.frames if f != page.main_frame]
                    if frames:
                        _log(f"  DIAGNOSTIC: page has {len(frames)} iframe(s): {frames}")
                except Exception:
                    pass
            except Exception as e:
                _log(f"  Diagnostic dump failed: {e}")
            # AI RECOVERY: Let AI analyze the page and try to find/navigate to the login form
            if ai_recover and ai_recover(page,
                    "Find the login form with a username or email input field. "
                    "If there is a 'Log In' button, click it to open the login form.",
                    "US Foods (order.usfoods.com)",
                    log_fn=_log,
                    extra_rules="- US Foods uses Azure AD B2C for authentication\n"
                    "- The login form may be behind a 'Log In' button on the landing page\n"
                    "- Look for input fields with type=email, name=signInName, or placeholder containing 'User ID'"):
                username_input = _find_input(page, username_selectors, "username (AI-recovered)")
            if not username_input:
                _log("  FATAL: No username input found (even after AI recovery)")
                return False

        _safe_fill(page, username_input, username)
        time.sleep(1)

        # Azure B2C uses a green "Log in" button (lowercase "in"); also keep
        # broader fallbacks so we still cover any per-tenant customizations.
        submit_selectors = [
            'button#next', 'button[id*="continue" i]',
            'button:has-text("Log in")', 'button:has-text("Log In")',
            'button[type="submit"]', 'button:has-text("Sign In")',
            'button:has-text("Sign in")', 'button:has-text("Next")',
            'button:has-text("Continue")', 'input[type="submit"]',
        ]
        if not _safe_click(page, submit_selectors, "submit"):
            page.keyboard.press("Enter")
        time.sleep(3)

        # Step 2: Handle 2FA — click "Email"
        # Azure B2C typically renders this as radio buttons or selectable
        # cards, not a plain <button>. Try radio inputs first, then card-
        # styled buttons, then plain text fallbacks.
        _log("  Looking for 2FA verification method selection...")
        time.sleep(3)

        # The B2C "verification method" page shows two card-styled
        # selectors: Text and Email. Each card has an icon + the label +
        # a masked contact (e.g., Email card shows "Email" + "D***l@gmail.com").
        # The cards are typically <button> or <div role="button">. The
        # key disambiguation is the *standalone* text "Email" — the masked
        # email contains "@gmail.com" but not "Email".
        email_selectors = [
            # Azure B2C radio-button patterns
            'input[type="radio"][value*="email" i]',
            'input[type="radio"][id*="email" i]',
            'input[type="radio"][name*="email" i]',
            'label[for*="email" i]',
            # Card / button patterns
            '[role="button"]:has-text("Email")',
            'button[id*="email" i]', 'button[data-method*="email" i]',
            'button:has-text("Email")', 'a:has-text("Email")',
            'button:has-text("Send code via email")',
            'button:has-text("Send Email Code")',
            'button:has-text("Email me")',
            # Generic text-near-clickable
            'label:has-text("Email")', 'div:has-text("Email") >> button',
            '[data-method="email"]',
            'span:has-text("Email")',
        ]
        email_clicked = False
        for sel in email_selectors:
            try:
                el = page.query_selector(sel)
                if el and el.is_visible():
                    el.click(timeout=5000)
                    _log(f"  Clicked email 2FA option: {sel}")
                    email_clicked = True
                    break
            except Exception:
                continue

        if not email_clicked:
            # Strict-text Playwright locator — matches an element whose
            # *exact* text content is "Email" (excludes the masked email
            # cell whose text is "D***l@gmail.com").
            try:
                loc = page.locator('text="Email"').first
                loc.click(timeout=5000)
                _log("  Clicked email option via Playwright text=Email locator")
                email_clicked = True
            except Exception:
                pass

        if not email_clicked:
            # JS DOM walk — find any clickable ancestor of a node whose
            # exact text is "Email", with an envelope-like icon nearby
            # OR a visible @ in the same card. Click the deepest button-
            # or role-button-like ancestor we can find.
            try:
                clicked_via_js = page.evaluate("""
                () => {
                    const walker = document.createTreeWalker(
                        document.body, NodeFilter.SHOW_TEXT);
                    while (walker.nextNode()) {
                        const t = (walker.currentNode.textContent || '').trim();
                        if (t === 'Email') {
                            // Walk up looking for a clickable parent
                            let el = walker.currentNode.parentElement;
                            for (let depth = 0; depth < 8 && el; depth++) {
                                const tag = el.tagName;
                                const role = el.getAttribute('role') || '';
                                const isClick = (
                                    tag === 'BUTTON' || tag === 'A' ||
                                    role === 'button' ||
                                    el.onclick != null ||
                                    el.classList.toString().match(/option|method|card|choice|tile/i)
                                );
                                if (isClick && el.offsetParent !== null) {
                                    el.click();
                                    return { tag, role,
                                        cls: el.className.toString().slice(0, 100) };
                                }
                                el = el.parentElement;
                            }
                        }
                    }
                    return null;
                }
                """)
                if clicked_via_js:
                    _log(f"  Clicked email via JS DOM walk: "
                         f"<{clicked_via_js['tag']} role={clicked_via_js['role']!r}>")
                    email_clicked = True
            except Exception as e:
                _log(f"  JS Email click error: {e}")

        if not email_clicked:
            # Last resort: get_by_text without exact (matches substring).
            try:
                page.get_by_text("Email", exact=False).first.click(timeout=5000)
                _log("  Clicked email option via fuzzy text search")
                email_clicked = True
            except Exception:
                _log("  Could not find email 2FA option")

        if not email_clicked:
            # Diagnostic dump — list every interactive element so we know
            # exactly what to target. Same self-debugging pattern as the
            # username-input dump above.
            try:
                dump = page.evaluate("""
                () => {
                    const out = { radios: [], buttons: [], labels: [], headings: [] };
                    document.querySelectorAll('input[type="radio"]').forEach(el => {
                        if (el.offsetParent !== null) out.radios.push({
                            id: el.id || '', name: el.name || '', value: el.value || '',
                            ariaLabel: el.getAttribute('aria-label') || '',
                        });
                    });
                    document.querySelectorAll('button').forEach(el => {
                        if (el.offsetParent !== null) out.buttons.push({
                            id: el.id || '', text: (el.innerText || '').trim().slice(0, 80),
                            ariaLabel: el.getAttribute('aria-label') || '',
                        });
                    });
                    document.querySelectorAll('label').forEach(el => {
                        if (el.offsetParent !== null) out.labels.push({
                            for_: el.getAttribute('for') || '',
                            text: (el.innerText || '').trim().slice(0, 80),
                        });
                    });
                    document.querySelectorAll('h1, h2, h3').forEach(el => {
                        if (el.offsetParent !== null) {
                            const t = (el.innerText || '').trim().slice(0, 100);
                            if (t) out.headings.push(t);
                        }
                    });
                    return out;
                }
                """)
                _log(f"  DIAGNOSTIC (2FA method page) URL: {page.url[:120]}")
                _log(f"  DIAGNOSTIC headings: {dump.get('headings', [])}")
                radios = dump.get('radios', [])
                _log(f"  DIAGNOSTIC {len(radios)} radio inputs:")
                for i, r in enumerate(radios[:10]):
                    _log(f"    [{i}] id={r['id']!r} name={r['name']!r} "
                         f"value={r['value']!r} aria={r['ariaLabel']!r}")
                buttons = dump.get('buttons', [])
                _log(f"  DIAGNOSTIC {len(buttons)} buttons:")
                for i, b in enumerate(buttons[:10]):
                    _log(f"    [{i}] id={b['id']!r} text={b['text']!r} "
                         f"aria={b['ariaLabel']!r}")
                labels = dump.get('labels', [])
                _log(f"  DIAGNOSTIC {len(labels)} labels:")
                for i, l in enumerate(labels[:10]):
                    _log(f"    [{i}] for={l['for_']!r} text={l['text']!r}")
            except Exception as e:
                _log(f"  Diagnostic dump failed: {e}")
            # AI RECOVERY: Let AI figure out the 2FA method selection
            if ai_recover and ai_recover(page,
                    "Select 'Email' as the verification method for 2FA. "
                    "Click the Email option/card/radio button to receive a verification code via email.",
                    "US Foods Azure B2C 2FA page",
                    log_fn=_log,
                    extra_rules="- This is a 2FA verification method selection page\n"
                    "- There should be options like 'Text' and 'Email'\n"
                    "- Click the 'Email' option, NOT a text/SMS option"):
                email_clicked = True
                _log("  AI recovered: selected email for 2FA")
            if not email_clicked:
                _log("  FATAL: Cannot select email for 2FA (even after AI recovery)")
                return False

        time.sleep(3)
        _safe_click(page, [
            'button:has-text("Send")', 'button:has-text("Submit")',
            'button:has-text("Continue")', 'button[type="submit"]',
        ], "send code")
        # CAPTURE CODE-REQUEST TIMESTAMP: any email that arrives AFTER
        # this point is a candidate; anything older predates our request
        # and must NOT be used. Subtract 30s as buffer for clock skew.
        code_request_time = datetime.now(timezone.utc) - timedelta(seconds=30)
        time.sleep(3)

        # Step 3: Wait for code from Gmail
        _log("  Waiting for 2FA code from Gmail...")
        code = _wait_for_2fa_code(gmail_address, gmail_app_password,
                                   request_time=code_request_time)
        if not code:
            _log("  FATAL: Did not receive 2FA code")
            return False

        # Step 4: Enter the verification code
        #
        # HISTORY (2026-05-01):
        #   The original approach used keyboard.type() for each single-digit
        #   input, but Azure B2C's framework (Angular) never registered the
        #   values because keyboard events alone don't trigger Angular's
        #   change detection. The form stayed on .../SelfAsserted/co and
        #   the verify button click had no effect (form thought inputs were
        #   empty). Fix: use JavaScript to set .value and dispatch 'input'
        #   + 'change' events so Angular picks up the values.
        #
        #   Additionally, the verify button selectors missed the B2C-
        #   specific IDs (#continue, #verifyCode, .verifyCode). The
        #   _safe_click fell through to keyboard Enter which also failed
        #   because the button wasn't focused.
        _log(f"  Entering verification code: {code}")
        code_selectors = [
            'input[name="code"]', 'input[name="otp"]',
            'input[name="verificationCode"]',
            'input[type="tel"]', 'input[type="number"]',
            'input[placeholder*="code" i]', 'input[maxlength="6"]',
            'input[autocomplete="one-time-code"]',
        ]

        code_entered = False
        single_digit_inputs = page.query_selector_all('input[maxlength="1"]')
        if len(single_digit_inputs) >= 6:
            _log(f"  Found {len(single_digit_inputs)} single-digit inputs — using JS value injection")
            # Use JavaScript to set values AND dispatch events so the
            # framework (Angular/React/B2C) registers the change. Plain
            # keyboard.type() doesn't trigger Angular's change detection.
            try:
                page.evaluate("""
                (code) => {
                    const inputs = document.querySelectorAll('input[maxlength="1"]');
                    for (let i = 0; i < 6 && i < inputs.length && i < code.length; i++) {
                        const inp = inputs[i];
                        // Focus + set native value
                        inp.focus();
                        inp.value = code[i];
                        // Dispatch all events Angular/React might listen to
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                        inp.dispatchEvent(new Event('change', { bubbles: true }));
                        inp.dispatchEvent(new KeyboardEvent('keyup', {
                            key: code[i], code: 'Digit' + code[i], bubbles: true
                        }));
                        inp.dispatchEvent(new KeyboardEvent('keydown', {
                            key: code[i], code: 'Digit' + code[i], bubbles: true
                        }));
                    }
                    // Also try setting via nativeInputValueSetter (React)
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    )?.set;
                    if (nativeSetter) {
                        for (let i = 0; i < 6 && i < inputs.length && i < code.length; i++) {
                            nativeSetter.call(inputs[i], code[i]);
                            inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    }
                }
                """, code)
                code_entered = True
                _log(f"  JS value injection complete for {min(6, len(single_digit_inputs))} inputs")
            except Exception as e:
                _log(f"  JS injection failed: {e} — falling back to keyboard")

            # Fallback: also try keyboard approach in case JS didn't work.
            # Track per-digit success so we don't claim success when 0 of 6
            # actually got entered (which would lead to clicking verify on
            # an empty form and failing silently downstream).
            if not code_entered:
                digits_entered = 0
                for i, digit in enumerate(code[:6]):
                    try:
                        single_digit_inputs[i].click(timeout=2000)
                        time.sleep(0.1)
                        page.keyboard.type(digit, delay=50)
                        time.sleep(0.2)
                        digits_entered += 1
                    except Exception as e:
                        _log(f"  Keyboard digit {i} entry failed: {e}")
                if digits_entered >= 6:
                    code_entered = True
                    _log(f"  Keyboard fallback entered all 6 digits")
                else:
                    _log(f"  WARNING: Keyboard fallback only entered "
                         f"{digits_entered}/6 digits — verification will likely fail")
                    # Mark as entered so we still attempt verify; the
                    # SelfAsserted-URL guard at line 1281 will detect
                    # the failure and the function returns False properly.
                    code_entered = (digits_entered > 0)

            # JS-side validation: confirm the inputs actually contain digits
            # before clicking verify. Catches the case where both JS injection
            # and keyboard fallback silently produced empty inputs.
            try:
                populated = page.evaluate("""
                () => {
                    const inputs = document.querySelectorAll('input[maxlength="1"]');
                    if (inputs.length < 6) return false;
                    return Array.from(inputs).slice(0, 6).every(
                        i => i.value && /\\d/.test(i.value)
                    );
                }
                """)
                if not populated:
                    _log(f"  WARNING: 2FA inputs still empty after entry attempts")
            except Exception:
                pass  # Best-effort check — proceed regardless
        else:
            code_input = _find_input(page, code_selectors, "verification code")
            if code_input:
                _safe_fill(page, code_input, code)
                code_entered = True
            else:
                _log("  No code input found — typing code via keyboard")
                page.keyboard.type(code, delay=80)
                code_entered = True

        time.sleep(1)

        # Check if the form auto-submitted after code entry (some B2C
        # configs auto-submit when all 6 digits are filled).
        current_url_after_code = page.url
        if 'SelfAsserted' not in current_url_after_code:
            _log(f"  Form auto-submitted after code entry! URL: {current_url_after_code[:120]}")
        else:
            # Form did NOT auto-submit — click the verify/continue button.
            # Azure B2C uses specific IDs: #continue is the main submit,
            # #verifyCode is the verify-code-specific button, and
            # .verifyCode is a class-based variant. The old selectors
            # missed ALL of these, causing the form to stay on
            # SelfAsserted/co indefinitely.
            _log("  Form still on SelfAsserted — clicking verify button...")
            verify_selectors = [
                # Azure B2C specific (HIGHEST priority — these are the
                # actual IDs on the B2C self-asserted page)
                'button#continue', '#continue',
                'button#verifyCode', '#verifyCode',
                'button.verifyCode', '.verifyCode',
                '#readButton',
                # B2C text-based
                'button:has-text("Verify code")',
                'button:has-text("Verify Code")',
                'button:has-text("Verify")',
                'button:has-text("Submit")',
                'button:has-text("Continue")',
                'button:has-text("Sign In")',
                'button:has-text("Sign in")',
                'button[type="submit"]',
                'button:has-text("Confirm")',
                'input[type="submit"]',
            ]
            verify_clicked = _safe_click(page, verify_selectors, "verify")
            if not verify_clicked:
                # JS fallback — find ANY submit-like button on the page
                _log("  Standard selectors missed — trying JS button search...")
                try:
                    clicked_info = page.evaluate("""
                    () => {
                        // Try by ID first (B2C standard)
                        for (const id of ['continue', 'verifyCode', 'readButton', 'next']) {
                            const el = document.getElementById(id);
                            if (el && el.offsetParent !== null) {
                                el.click();
                                return { method: 'id', id: id, tag: el.tagName };
                            }
                        }
                        // Try submit buttons
                        const submits = document.querySelectorAll(
                            'button[type="submit"], input[type="submit"]'
                        );
                        for (const el of submits) {
                            if (el.offsetParent !== null) {
                                el.click();
                                return { method: 'submit', tag: el.tagName,
                                         text: (el.textContent || el.value || '').trim().slice(0, 40) };
                            }
                        }
                        // Try any button with verify/continue/submit text
                        const want = ['verify', 'continue', 'submit', 'confirm', 'next'];
                        const buttons = document.querySelectorAll('button');
                        for (const el of buttons) {
                            const t = (el.textContent || '').trim().toLowerCase();
                            if (want.some(w => t.includes(w)) && el.offsetParent !== null) {
                                el.click();
                                return { method: 'text', text: t.slice(0, 40), tag: 'BUTTON' };
                            }
                        }
                        return null;
                    }
                    """)
                    if clicked_info:
                        _log(f"  Clicked verify via JS: {clicked_info}")
                        verify_clicked = True
                    else:
                        _log("  JS button search found nothing — pressing Enter as last resort")
                        page.keyboard.press("Enter")
                except Exception as e:
                    _log(f"  JS verify click error: {e} — pressing Enter")
                    page.keyboard.press("Enter")

            # Wait for URL to change away from SelfAsserted (indicates
            # verification succeeded). If it doesn't change, the code
            # entry or verify click failed.
            try:
                page.wait_for_url(
                    lambda url: 'SelfAsserted' not in url,
                    timeout=15000
                )
                _log(f"  Verification submitted — URL changed to: {page.url[:120]}")
            except Exception:
                _log(f"  WARNING: URL still on SelfAsserted after verify click: "
                     f"{page.url[:120]}")
                # Diagnostic dump — what buttons are on the page?
                try:
                    btns = page.evaluate("""
                    () => document.querySelectorAll('button, input[type="submit"]')
                        .length
                    """)
                    btn_details = page.evaluate("""
                    () => Array.from(
                        document.querySelectorAll('button, input[type="submit"]')
                    ).slice(0, 10).map(el => ({
                        id: el.id || '', tag: el.tagName,
                        text: (el.textContent || el.value || '').trim().slice(0, 60),
                        type: el.type || '', visible: el.offsetParent !== null,
                        cls: (el.className || '').toString().slice(0, 80),
                    }))
                    """)
                    _log(f"  DIAGNOSTIC: {btns} buttons on page:")
                    for b in btn_details:
                        _log(f"    id={b['id']!r} tag={b['tag']} text={b['text']!r} "
                             f"type={b['type']!r} vis={b['visible']} cls={b['cls']!r}")
                except Exception as e:
                    _log(f"  Button diagnostic failed: {e}")

        # IMPORTANT — do NOT call _dismiss_popups here. Its selector list
        # includes "Not now" / "No thanks" / "Continue" which would click
        # the WRONG button on the "Stay signed in?" prompt. We need to find
        # and click "Yes" first, THEN dismiss any leftover popups.
        #
        # After code verification (whether auto-submitted or manually
        # clicked), B2C processes the auth at an intermediate URL like
        # `.../CombinedSigninA`. This can take 5-15 seconds before B2C
        # redirects to the KMSI ("Stay signed in?") page or directly
        # back to usfoods.com. We MUST wait for the URL to leave this
        # intermediate state before checking for the stay-signed-in
        # prompt — otherwise we check too early and miss it entirely.
        current_url = page.url.lower()
        if 'combinedsignin' in current_url or 'selfasserted' in current_url:
            _log("  Waiting for B2C to finish processing (leave CombinedSignin)...")
            try:
                page.wait_for_url(
                    lambda url: ('combinedsignin' not in url.lower()
                                 and 'selfasserted' not in url.lower()),
                    timeout=30000
                )
                _log(f"  B2C processing complete — URL: {page.url[:120]}")
            except Exception:
                _log(f"  B2C still processing after 30s — URL: {page.url[:120]}")
        time.sleep(3)  # Extra buffer for page render after redirect

        # Step 5: Handle "Stay signed in?" / "Trust this device?" prompt that
        # appears AFTER 2FA verification but BEFORE the dashboard. If the
        # scraper doesn't click "Yes", B2C records `rememberMe=false` and
        # the redirect back to usfoods.com may not complete. The post-2FA
        # URL pattern `.../confirmed?rememberMe=false` is the smoking gun
        # for this state.
        #
        # If we've already been redirected to usfoods.com, the KMSI step
        # was either skipped or auto-accepted — skip straight to verify.
        # (Previous code set stay_signed_in_clicked=True inside the if/else
        # and then unconditionally overwrote it with the same URL check on
        # the very next line. Collapsed for clarity — behavior unchanged.)
        if 'order.usfoods.com' in page.url:
            _log("  Already on usfoods.com — KMSI step not needed")
        else:
            _log("  Checking for 'Stay signed in?' / trust-device prompt...")
        stay_signed_in_clicked = ('order.usfoods.com' in page.url)
        stay_signed_in_selectors = [
            'button:has-text("Yes")',
            'button:has-text("Stay signed in")',
            'button:has-text("Keep me signed in")',
            'button:has-text("Trust this device")',
            'button:has-text("Remember me")',
            'button:has-text("Continue")',
            'button:has-text("OK")',
        ]
        for sel in stay_signed_in_selectors:
            try:
                el = page.query_selector(sel)
                if el and el.is_visible():
                    el_text = (el.inner_text() or '').strip()[:40]
                    el.click(timeout=5000)
                    _log(f"  Clicked stay-signed-in: {sel} (text: '{el_text}')")
                    stay_signed_in_clicked = True
                    time.sleep(3)
                    break
            except Exception:
                continue
        if not stay_signed_in_clicked:
            # Fallback: text-based search for the prompt
            try:
                heading = page.query_selector('h1, h2, h3, [role="heading"]')
                if heading:
                    h_text = (heading.inner_text() or '').lower()
                    if 'stay signed' in h_text or 'trust this' in h_text or 'keep me signed' in h_text:
                        _log(f"  Detected post-2FA prompt heading: '{h_text[:80]}'")
                        # Try to click any "Yes" / primary button
                        for fallback_sel in ['button:has-text("Yes")', 'button[type="submit"]']:
                            try:
                                fb = page.query_selector(fallback_sel)
                                if fb and fb.is_visible():
                                    fb.click(timeout=3000)
                                    _log(f"  Clicked post-2FA via fallback: {fallback_sel}")
                                    stay_signed_in_clicked = True
                                    time.sleep(3)
                                    break
                            except Exception:
                                continue
            except Exception:
                pass
        if not stay_signed_in_clicked:
            # Last-ditch JS approach — find any button on the b2clogin
            # page whose text is "Yes" / "Sí" and click it. The prompt
            # is usually two buttons: Yes and No.
            try:
                clicked_yes = page.evaluate("""
                () => {
                    const want = ['yes', 'sí', 'si'];
                    const els = document.querySelectorAll('button, input[type="submit"], [role="button"]');
                    for (const el of els) {
                        const t = (el.textContent || el.value || '').trim().toLowerCase();
                        if (want.includes(t) && el.offsetParent !== null) {
                            el.click();
                            return t;
                        }
                    }
                    return null;
                }
                """)
                if clicked_yes:
                    _log(f"  Clicked 'Yes' via final JS fallback: '{clicked_yes}'")
                    stay_signed_in_clicked = True
                    time.sleep(3)
                else:
                    _log("  No stay-signed-in prompt detected (or already past it)")
            except Exception as e:
                _log(f"  Stay-signed-in JS fallback error: {e}")

        # Step 6: Wait for B2C to redirect back to order.usfoods.com.
        # The login isn't complete until the URL leaves b2clogin.com — at
        # which point the session cookies are set on usfoods.com and the
        # scraper can navigate to /desktop/lists with a real session.
        # Without this wait, _verify_authenticated would run while still
        # on the b2clogin "confirmed" page and return False (URL contains
        # "signin").
        _log("  Waiting for redirect back to order.usfoods.com...")
        try:
            page.wait_for_url("**order.usfoods.com/**", timeout=25000)
            _log(f"  Redirected back to: {page.url[:120]}")
        except Exception:
            _log(f"  No redirect to order.usfoods.com within 25s — URL: "
                 f"{page.url[:120]}")
            # If we're stuck on b2clogin.com/confirmed, try forcing the
            # navigation manually — sometimes the page needs a nudge.
            if 'b2clogin.com' in page.url and 'confirmed' in page.url.lower():
                try:
                    _log("  Forcing navigation to /desktop/home to complete OAuth...")
                    page.goto("https://order.usfoods.com/desktop/home",
                              wait_until="domcontentloaded", timeout=20000)
                    time.sleep(3)
                except Exception as e:
                    _log(f"  Forced nav failed: {e}")

        time.sleep(3)
        _dismiss_popups(page)

        # Step 7: Verify login actually succeeded by checking DOM, not just URL.
        if _verify_authenticated(page):
            _log("  Login successful (DOM-verified)!")
            return True

        time.sleep(5)
        _dismiss_popups(page)
        if _verify_authenticated(page):
            _log("  Login successful after wait (DOM-verified)!")
            return True

        _log(f"  Login attempt {attempt + 1} failed — URL: {page.url}")

    return False


# ── Scroll to load all items ────────────────────────────────────────────────
def _scroll_to_load_all(page):
    count_js = """
    () => {
        const text = document.body.innerText || '';
        const matches = text.match(/#(\\d{7})\\b/g) || [];
        const ids = new Set(matches.map(m => m.replace('#', '')));
        return { count: ids.size };
    }
    """
    prev_count = 0
    stable_rounds = 0

    for scroll_attempt in range(MAX_SCROLL_ATTEMPTS):
        try:
            info = page.evaluate(count_js)
            current_count = info['count']
        except Exception:
            current_count = prev_count

        if current_count > prev_count:
            _log(f"  Scroll {scroll_attempt}: {current_count} unique IDs (+{current_count - prev_count})")
            prev_count = current_count
            stable_rounds = 0
        else:
            stable_rounds += 1

        if stable_rounds >= STABLE_SCROLLS_BEFORE_STOP and scroll_attempt > 5:
            _log(f"  Scroll complete — {current_count} items after {scroll_attempt} scrolls")
            break

        try:
            page.evaluate("window.scrollBy(0, 800)")
        except Exception:
            pass
        time.sleep(SCROLL_PAUSE_SEC)

    try:
        final = page.evaluate(count_js)
        _log(f"  Final: {final['count']} unique item IDs")
        return final['count']
    except Exception:
        return prev_count


# ── Item extraction ─────────────────────────────────────────────────────────
def _extract_items_js(page):
    js_extract = """
    () => {
        const items = [];
        const seen = new Set();

        // US Foods IDs are 7 digits with # prefix (e.g., #6007322)
        // Skip the location number in the header (e.g., 54487731 — 8 digits)
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const idNodes = [];
        while (walker.nextNode()) {
            const t = walker.currentNode.textContent.trim();
            // Look for #1234567 pattern (7 digits with # prefix)
            const m = t.match(/#(\\d{7})\\b/);
            if (m && !seen.has(m[1])) {
                seen.add(m[1]);
                idNodes.push({ id: m[1], node: walker.currentNode });
            }
        }

        for (const { id, node } of idNodes) {
            let el = node.parentElement;
            let container = null;
            let containerText = '';

            for (let depth = 0; depth < 30; depth++) {
                if (!el) break;
                const txt = el.innerText || '';
                if (txt.includes(id) && txt.length > 20) {
                    container = el;
                    containerText = txt;
                    const prices = txt.match(/\\$(\\d+\\.\\d{2})/g);
                    if (prices && prices.some(p => parseFloat(p.replace('$','')) > 0)) {
                        break;
                    }
                }
                el = el.parentElement;
            }

            if (!container) continue;

            const item = {
                id: id, name: '', price: null, originalPrice: null, unit: 'CS',
                pack: '', brand: '', lastOrdered: '',
                raw: containerText.substring(0, 800)
            };

            // --- Price detection with sale/strikethrough awareness ---
            const html = container.innerHTML || '';
            const strikePattern = /<(?:s|strike|del|span[^>]*line-through[^>]*)>[^<]*\\$(\\d+\\.\\d{2})[^<]*<\\/(?:s|strike|del|span)>/gi;
            const strikeMatches = [];
            let sm;
            while ((sm = strikePattern.exec(html)) !== null) {
                const sv = parseFloat(sm[1]);
                if (sv > 0 && sv < 10000) strikeMatches.push(sv);
            }

            const allPrices = [];
            // US Foods uses "$18.59 cs" format (lowercase unit, no slash)
            const priceMatches = containerText.match(/\\$(\\d+\\.\\d{2})\\s*\\/?\\s*(cs|ea|lb|oz|ct|gal|dz|pk|bg|ca|CS|EA|LB|OZ|CT|GAL|DZ|PK|BG|CA)?/gi);
            if (priceMatches) {
                for (const pm of priceMatches) {
                    const pp = pm.match(/\\$(\\d+\\.\\d{2})\\s*\\/?\\s*(cs|ea|lb|oz|ct|gal|dz|pk|bg|ca|CS|EA|LB|OZ|CT|GAL|DZ|PK|BG|CA)?/i);
                    if (pp) {
                        const pv = parseFloat(pp[1]);
                        if (pv > 0 && pv < 10000) {
                            allPrices.push({ price: pv, unit: (pp[2] || 'CS').toUpperCase() });
                        }
                    }
                }
            }

            if (strikeMatches.length > 0 && allPrices.length > 1) {
                const strikeSet = new Set(strikeMatches.map(p => p.toFixed(2)));
                const salePrices = allPrices.filter(p => !strikeSet.has(p.price.toFixed(2)));
                if (salePrices.length > 0) {
                    item.originalPrice = strikeMatches[0];
                    item.price = salePrices[0].price;
                    item.unit = salePrices[0].unit;
                } else {
                    const last = allPrices[allPrices.length - 1];
                    item.price = last.price;
                    item.unit = last.unit;
                }
            } else if (allPrices.length >= 2) {
                const uniquePrices = [...new Set(allPrices.map(p => p.price))];
                if (uniquePrices.length >= 2) {
                    const higher = Math.max(...uniquePrices);
                    const lower = Math.min(...uniquePrices);
                    if (lower < higher && lower > higher * 0.3) {
                        item.originalPrice = higher;
                        item.price = lower;
                        item.unit = allPrices.find(p => p.price === lower)?.unit || 'CS';
                    } else {
                        const last = allPrices[allPrices.length - 1];
                        item.price = last.price;
                        item.unit = last.unit;
                    }
                } else {
                    item.price = allPrices[0].price;
                    item.unit = allPrices[0].unit;
                }
            } else if (allPrices.length === 1) {
                item.price = allPrices[0].price;
                item.unit = allPrices[0].unit;
            }

            if (!item.price) {
                const noDollar = containerText.match(/(\\d+\\.\\d{2})\\s*\\/?\\s*(CS|EA|LB|OZ|CT|GAL|DZ|PK|BG|CA)/gi);
                if (noDollar) {
                    for (const nd of noDollar) {
                        const np = nd.match(/(\\d+\\.\\d{2})\\s*\\/?\\s*(CS|EA|LB|OZ|CT|GAL|DZ|PK|BG|CA)/i);
                        if (np) {
                            const nv = parseFloat(np[1]);
                            if (nv > 1 && nv < 10000) {
                                item.price = nv;
                                item.unit = (np[2] || 'CS').toUpperCase();
                            }
                        }
                    }
                }
            }

            // Pack size
            const packMatch = containerText.match(/(\\d+\\/[\\d.]+\\s*(?:LB|OZ|CT|CS|EA|GAL|GM|DZ|PK|BG))/i);
            if (packMatch) item.pack = packMatch[1];

            // Last ordered date
            const dateMatch = containerText.match(/(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})/);
            if (dateMatch) item.lastOrdered = dateMatch[1];

            // Brand (ALL-CAPS line)
            const lines = containerText.split('\\n').map(l => l.trim()).filter(l => l);
            for (const ln of lines) {
                if (/^[A-Z][A-Z\\s\\/&.-]+$/.test(ln) && ln.length > 2 && ln.length < 50 && !ln.match(/^\\d/)) {
                    item.brand = ln;
                    break;
                }
            }

            // Name
            const skipWords = ['item details', 'last ordered', 'order qty', 'price',
                'total', 'buy it again', 'add to', 'remove', 'view details',
                'purchase history', 'order history', 'reorder', 'added to cart',
                'frequently bought', 'similar items', 'out of stock',
                'weekly average', 'your price', 'list price', 'case price'];
            for (const ln of lines) {
                const low = ln.toLowerCase();
                if (ln.includes(id)) continue;
                if (ln.startsWith('$')) continue;
                if (/^\\d+\\.\\d{2}/.test(ln)) continue;
                if (/^\\d+\\//.test(ln) && ln.length < 15) continue;
                if (/^\\d{1,2}\\/\\d{1,2}\\//.test(ln)) continue;
                if (skipWords.some(w => low.includes(w))) continue;
                if (ln.length < 4 || ln.length > 120) continue;
                if (/^\\d+$/.test(ln)) continue;
                item.name = ln;
                break;
            }

            if (!item.name) item.name = 'US Foods Item ' + id;

            items.push(item);
        }

        return { items: items, totalIds: seen.size };
    }
    """
    try:
        result = page.evaluate(js_extract)
        return result.get("items", [])
    except Exception as e:
        _log(f"  JS extraction error: {e}")
        return []


def _extract_items_text_fallback(page):
    results = []
    try:
        body_text = page.inner_text('body')
    except Exception:
        return results

    lines = [l.strip() for l in body_text.split('\n') if l.strip()]
    _log(f"  Text fallback: {len(lines)} lines")

    id_pattern = re.compile(r'#(\d{7})\b')
    price_pattern = re.compile(r'\$(\d+\.?\d*)\s*(CS|EA|LB|OZ|CT|GAL|DZ|PK|BG|CA)?', re.IGNORECASE)

    seen = set()
    for idx, line in enumerate(lines):
        m = id_pattern.search(line)
        if not m or m.group(1) in seen:
            continue
        sid = m.group(1)
        seen.add(sid)

        price_val = None
        unit = "CS"
        for j in range(max(0, idx - 3), min(len(lines), idx + 10)):
            pm = price_pattern.search(lines[j])
            if pm:
                pv = float(pm.group(1))
                if pv > 0:
                    price_val = pv
                    unit = (pm.group(2) or "CS").upper()
                    break

        name = f"US Foods Item {sid}"
        for back in range(1, 5):
            if idx - back >= 0:
                cand = lines[idx - back]
                if (len(cand) > 3 and not cand.startswith('$')
                        and not id_pattern.match(cand) and len(cand) < 120):
                    name = cand
                    break

        pack = ""
        pack_pattern = re.compile(r'(\d+/[\d.]+\s*(?:LB|OZ|CT|CS|EA|GAL|GM|DZ|PK|BG))', re.IGNORECASE)
        for j in range(max(0, idx - 2), min(len(lines), idx + 6)):
            pm = pack_pattern.search(lines[j])
            if pm:
                pack = pm.group(1)
                break

        if price_val and price_val > 0:
            results.append({
                "name": name, "usfoodsId": sid, "price": price_val,
                "pack": pack, "brand": "", "lastOrdered": "", "unit": unit,
            })

    _log(f"  Text fallback: {len(results)} items with prices")
    return results


# ── Download Order Guide CSV (preferred path) ──────────────────────────────
def _download_orderguide_csv(page):
    """Navigate to DD Mau Orderguide and download the CSV export.

    Confirmed flow via watching Andrew do it manually in Safari (2026-05-01):
      1. From homepage, click "DD Mau Orderguide" link (in the My Lists card)
         OR navigate to My Lists → Shopping Lists → DD Mau Orderguide.
      2. Order guide page loads showing 76 products grouped by category
         (e.g., PRODUCE (10 PRODUCTS)). Standard HTML, NOT Ionic.
      3. Click "Download" link at top-right (next to "Print" — both are
         plain links/buttons in a top action bar, with a download icon).
      4. Modal opens: "Download DD Mau Orderguide" with three sections:
         - File Name (default "DD Mau Orderguide")
         - Select Format (default CSV)
         - Download Options
      5. Click green "Download" button at bottom of modal → CSV downloads.

    Key insight: the site uses standard HTML (divs, buttons, links) — NOT
    Ionic ion-* elements. Previous selectors targeting ion-item, ion-card,
    ion-button were all wrong.

    Returns a list of item dicts. Returns [] on failure.
    """
    import csv as _csv
    from io import StringIO
    import traceback as _tb

    _log("Downloading order guide CSV (export flow)...")

    # ── Step 1: Navigate to order guide ──
    # Try two approaches: (A) click the DD Mau Orderguide link directly
    # from whatever page we're on (homepage has it in the My Lists card),
    # or (B) navigate to /desktop/lists first and click from there.

    # First, make sure we're on the homepage.
    # IMPORTANT: After login, we're often already on /desktop/home.
    # Re-navigating to the same page causes V8 heap crashes in Railway's
    # memory-constrained environment. Skip the goto if we're already there.
    current = page.url.lower()
    if '/desktop/home' in current:
        _log("  Already on /desktop/home — skipping navigation (avoids crash)")
    else:
        try:
            _log("  Loading homepage /desktop/home ...")
            page.goto("https://order.usfoods.com/desktop/home",
                      wait_until="domcontentloaded", timeout=30000)
            _log(f"  Loaded — URL: {page.url[:120]}")
        except Exception as e:
            _log(f"  Failed to load homepage: {e}")
            _log(f"  Traceback: {_tb.format_exc()}")
            return []

    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        _log("  networkidle timed out — page may still be usable")
    time.sleep(3)
    try:
        _dismiss_popups(page)
    except Exception:
        pass

    # Tab-alive check
    try:
        page.evaluate("1")
    except Exception as alive_err:
        if "crash" in str(alive_err).lower() or "target" in str(alive_err).lower():
            _log(f"  Page tab CRASHED during homepage load: {alive_err}")
            return []

    # Sanity check — make sure we're logged in
    final_url = page.url.lower()
    try:
        sanity_text = (page.inner_text('body') or '')[:6000].lower()
    except Exception:
        sanity_text = ''
    if '/search/browse' in final_url or (
        'become a customer' in sanity_text and 'log in' in sanity_text
    ):
        _log(f"  ABORT: homepage looks logged-out (URL: {page.url})")
        return []

    # ── Step 2: Click DD Mau Orderguide link ──
    # On the homepage, there's a "My Lists" card with "DD Mau Orderguide"
    # as a clickable button/link. Standard HTML.
    _log("  Looking for DD Mau Orderguide link...")
    guide_clicked = False

    # Standard HTML selectors (what the real site uses)
    guide_selectors = [
        'a:has-text("DD Mau Orderguide")',
        'button:has-text("DD Mau Orderguide")',
        'a:has-text("DD Mau Order")',
        'button:has-text("DD Mau Order")',
        '[href*="lists/view"]',
        'a:has-text("Orderguide")',
        'button:has-text("Orderguide")',
    ]
    for sel in guide_selectors:
        try:
            el = page.query_selector(sel)
            if el and el.is_visible():
                el.click(timeout=10000)
                _log(f"  Clicked DD Mau Orderguide via {sel}")
                guide_clicked = True
                break
        except Exception:
            continue

    # Playwright text locator fallback
    if not guide_clicked:
        for text in ["DD Mau Orderguide", "DD Mau Order", "Orderguide"]:
            try:
                loc = page.get_by_text(text, exact=False).first
                if loc and loc.is_visible():
                    loc.click(timeout=10000)
                    _log(f"  Clicked via text locator: '{text}'")
                    guide_clicked = True
                    break
            except Exception:
                continue

    # If homepage didn't have the link, try navigating to /desktop/lists
    if not guide_clicked:
        _log("  Not found on homepage — trying /desktop/lists...")
        try:
            page.goto("https://order.usfoods.com/desktop/lists",
                      wait_until="domcontentloaded", timeout=30000)
            try:
                page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass
            time.sleep(3)
            try:
                _dismiss_popups(page)
            except Exception:
                pass
            # Try clicking from lists page
            for sel in guide_selectors:
                try:
                    el = page.query_selector(sel)
                    if el and el.is_visible():
                        el.click(timeout=10000)
                        _log(f"  Clicked DD Mau Orderguide from lists via {sel}")
                        guide_clicked = True
                        break
                except Exception:
                    continue
        except Exception as e:
            _log(f"  Failed to load /desktop/lists: {e}")

    # JS DOM walk as final fallback
    if not guide_clicked:
        try:
            clicked = page.evaluate("""
            () => {
                const els = document.querySelectorAll('a, button, [role="button"]');
                for (const el of els) {
                    const t = (el.textContent || '').trim().toLowerCase();
                    if (t.includes('dd mau') && t.includes('orderguide')
                        && el.offsetParent !== null) {
                        el.click();
                        return el.tagName;
                    }
                }
                // Broader search — walk all visible elements
                for (const el of document.querySelectorAll('*')) {
                    if (el.children.length > 5) continue;
                    const t = (el.textContent || '').trim().toLowerCase();
                    if (t.includes('dd mau') && (t.includes('orderguide') || t.includes('order guide'))
                        && el.offsetParent !== null) {
                        el.click();
                        return 'fallback-' + el.tagName;
                    }
                }
                return null;
            }
            """)
            if clicked:
                _log(f"  Clicked DD Mau Orderguide via JS fallback (<{clicked}>)")
                guide_clicked = True
        except Exception as e:
            _log(f"  JS fallback error: {e}")

    if not guide_clicked:
        # AI RECOVERY: Let AI navigate to the order guide
        if ai_navigate_to_goal and ai_navigate_to_goal(page,
                "Navigate to the DD Mau Orderguide (shopping list). "
                "Look for 'My Lists' or 'Shopping Lists' in the navigation, then click 'DD Mau Orderguide'.",
                "US Foods (order.usfoods.com)",
                max_steps=5,
                extra_rules="- The order guide is a shopping list under My Lists\n"
                "- Navigate to /desktop/lists if needed\n"
                "- Click on 'DD Mau Orderguide' link"):
            guide_clicked = True
            _log("  AI recovered: navigated to order guide")
    if not guide_clicked:
        _log("  Could not find DD Mau Orderguide link anywhere (even after AI recovery)")
        return []

    # Wait for order guide page to load
    try:
        page.wait_for_url("**/lists/view/**", timeout=15000)
        _log(f"  Order guide page: {page.url}")
    except Exception:
        # The URL might use a different pattern — check if page loaded
        _log(f"  No URL change to /lists/view/ — current URL: {page.url}")
        # Check if the page has order guide content anyway
        time.sleep(3)
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        pass
    time.sleep(2)
    try:
        _dismiss_popups(page)
    except Exception:
        pass

    # Verify we're on the order guide page — should show product count
    try:
        body = (page.inner_text('body') or '')[:3000].lower()
        if 'products' in body or 'produce' in body or 'orderguide' in body:
            _log("  Order guide page confirmed (found products/produce text)")
        else:
            _log(f"  WARNING: page might not be order guide. Preview: {body[:200]}")
    except Exception:
        pass

    # ── Step 3: Click the "Download" link at top-right ──
    # From the screenshot: "Download" is a text link next to "Print" in the
    # top-right action bar area, with a download icon. Standard HTML.
    _log("  Looking for top-right 'Download' link...")
    download_button_clicked = False

    # The page has a "Download" link in the action bar. Target it directly.
    download_selectors = [
        'a:has-text("Download")',
        'button:has-text("Download")',
        '[aria-label*="download" i]',
        '[aria-label*="Download"]',
    ]
    for sel in download_selectors:
        try:
            els = page.query_selector_all(sel)
            for el in els:
                try:
                    if el and el.is_visible():
                        el_text = (el.inner_text() or '').strip().lower()
                        if el_text == 'download':
                            el.click(timeout=10000)
                            _log(f"  Clicked top-right Download via {sel}")
                            download_button_clicked = True
                            break
                except Exception:
                    continue
            if download_button_clicked:
                break
        except Exception:
            continue

    # Playwright text locator fallback
    if not download_button_clicked:
        try:
            dl = page.get_by_text("Download", exact=True).first
            if dl and dl.is_visible():
                dl.click(timeout=10000)
                _log("  Clicked Download via text locator")
                download_button_clicked = True
        except Exception:
            pass

    if not download_button_clicked:
        _log("  Could not find Download button on order guide page")
        # Log what's on the page for debugging
        try:
            body = page.inner_text('body') or ''
            _log(f"  Page preview: {body[:500]}")
        except Exception:
            pass
        return []

    # ── Step 4: Wait for download modal ──
    # Modal title: "Download DD Mau Orderguide"
    # Modal has: File Name input, Select Format (CSV), Download Options
    # and a green "Download" button at the bottom.
    _log("  Waiting for download modal...")
    try:
        page.wait_for_selector('text="Download DD Mau Orderguide"',
                               timeout=15000)
        _log("  Modal opened")
    except Exception:
        # Try partial match
        try:
            page.wait_for_selector('text="Download"', timeout=5000)
            _log("  Modal may have opened (found 'Download' text)")
        except Exception:
            _log("  Modal title not found — proceeding anyway")
    time.sleep(2)

    # ── Step 4b: Select "Pricing" in Download Options ──
    # The modal has a "Download Options" section with checkboxes/toggles
    # for which columns to include. "Pricing" must be selected or the
    # exported CSV won't contain price columns, making it useless.
    _log("  Looking for Pricing option in download modal...")
    pricing_selected = False

    # First, capture modal DOM structure for debugging
    try:
        modal_html = page.evaluate("""
        () => {
            // Find the modal/dialog container
            const modal = document.querySelector(
                '[role="dialog"], .modal, .MuiDialog-root, .MuiModal-root, ' +
                '[class*="modal"], [class*="Modal"], [class*="dialog"], ' +
                '[class*="Dialog"], [class*="overlay"], [class*="Overlay"], ' +
                '[class*="popup"], [class*="Popup"], [class*="drawer"], ' +
                '[aria-modal="true"]'
            );
            if (modal) return modal.innerHTML.substring(0, 4000);
            // Fallback: get all visible content
            return document.body.innerHTML.substring(0, 4000);
        }
        """)
        _log(f"  Modal DOM snapshot (first 800 chars): {modal_html[:800]}")
    except Exception as e:
        _log(f"  Could not capture modal DOM: {e}")
        modal_html = ""

    # Method 1: Look for Download Options section and click Pricing
    # US Foods modal has "Download Options" header with clickable option items
    try:
        result = page.evaluate("""
        () => {
            // Strategy A: Find all clickable elements in the modal with "pric" text
            const modal = document.querySelector(
                '[role="dialog"], .modal, [class*="modal"], [class*="Modal"], ' +
                '[class*="dialog"], [class*="Dialog"], [aria-modal="true"]'
            ) || document.body;

            // Look for elements that are part of download options
            const allEls = modal.querySelectorAll('*');
            const candidates = [];
            for (const el of allEls) {
                const text = (el.textContent || '').trim().toLowerCase();
                const ownText = Array.from(el.childNodes)
                    .filter(n => n.nodeType === 3)
                    .map(n => n.textContent.trim().toLowerCase())
                    .join(' ');
                // Match "pricing", "price", or elements whose own text has "pric"
                if ((ownText.includes('pric') || (text.includes('pric') && text.length < 50))
                    && el.offsetParent !== null) {
                    candidates.push({
                        tag: el.tagName.toLowerCase(),
                        className: (el.className || '').toString().substring(0, 100),
                        text: text.substring(0, 60),
                        ownText: ownText.substring(0, 60),
                        clickable: !!(el.onclick || el.getAttribute('role') === 'checkbox'
                            || el.getAttribute('role') === 'switch'
                            || el.tagName === 'INPUT' || el.tagName === 'BUTTON'
                            || el.tagName === 'A' || el.tagName === 'LABEL'
                            || el.closest('label') || el.style.cursor === 'pointer'
                            || window.getComputedStyle(el).cursor === 'pointer')
                    });
                }
            }
            return candidates;
        }
        """)
        _log(f"  Pricing candidates found: {result}")
    except Exception as e:
        _log(f"  Candidate scan error: {e}")
        result = []

    # Method 2: Toggle the Pricing option ON if not already on.
    # IMPORTANT: This option may be checked-by-default. An unconditional click would
    # TOGGLE IT OFF, producing a CSV with no price columns. Always check state first
    # and only click if currently unchecked. Always verify final state.
    if not pricing_selected:
        try:
            clicked = page.evaluate("""
            () => {
                const modal = document.querySelector(
                    '[role="dialog"], .modal, [class*="modal"], [class*="Modal"], ' +
                    '[class*="dialog"], [class*="Dialog"], [aria-modal="true"]'
                ) || document.body;

                // Read current checked-state of an input or aria-checkable element.
                const isChecked = (el) => {
                    if (el.checked === true) return true;
                    const ac = el.getAttribute && el.getAttribute('aria-checked');
                    if (ac === 'true') return true;
                    const ap = el.getAttribute && el.getAttribute('aria-pressed');
                    if (ap === 'true') return true;
                    if (el.classList && (el.classList.contains('checked') ||
                        el.classList.contains('selected') ||
                        el.classList.contains('active'))) return true;
                    return false;
                };

                // Strategy 1: Find an input/aria-checkable inside an option labelled "pric".
                const inputs = modal.querySelectorAll(
                    'input[type="checkbox"], input[type="radio"], ' +
                    '[role="checkbox"], [role="switch"], [role="radio"]'
                );
                for (const inp of inputs) {
                    const container = inp.closest('label, div, li, span, [class*="option"], [class*="Option"]');
                    if (container && (container.textContent || '').toLowerCase().includes('pric')) {
                        const wasChecked = isChecked(inp);
                        if (wasChecked) {
                            return { method: 'input_already_checked', tag: inp.tagName,
                                     text: container.textContent.trim().substring(0, 50),
                                     alreadyChecked: true };
                        }
                        inp.click();
                        return { method: 'input_click', tag: inp.tagName,
                                 text: container.textContent.trim().substring(0, 50),
                                 alreadyChecked: false };
                    }
                }

                // Strategy 2: Find a label with "pric" text — its associated input
                // may toggle when we click the label. Skip if input is already checked.
                const labels = modal.querySelectorAll(
                    'label, [class*="option"], [class*="Option"], ' +
                    '[class*="choice"], [class*="Choice"], [class*="toggle"], ' +
                    '[class*="Toggle"], [class*="check"], [class*="Check"], ' +
                    'li, [role="option"], [role="menuitemcheckbox"]'
                );
                for (const lbl of labels) {
                    const t = (lbl.textContent || '').trim().toLowerCase();
                    if (!t.includes('pric') || t.length >= 80) continue;
                    const inp = lbl.querySelector(
                        'input[type="checkbox"], input[type="radio"], ' +
                        '[role="checkbox"], [role="switch"], [role="radio"]'
                    ) || (lbl.htmlFor ? document.getElementById(lbl.htmlFor) : null);
                    if (inp && isChecked(inp)) {
                        return { method: 'label_already_checked', tag: lbl.tagName,
                                 text: t.substring(0, 50), alreadyChecked: true };
                    }
                    lbl.click();
                    return { method: 'label_click', tag: lbl.tagName,
                             text: t.substring(0, 50), alreadyChecked: false };
                }

                // Strategy 3: Toggle/switch element next to a "Pricing" label.
                const allEls = Array.from(modal.querySelectorAll('*'));
                const pricingEl = allEls.find(el => {
                    const ownText = Array.from(el.childNodes)
                        .filter(n => n.nodeType === 3)
                        .map(n => n.textContent.trim())
                        .join('');
                    return ownText.toLowerCase().includes('pric');
                });
                if (pricingEl) {
                    const toggle = pricingEl.closest('div, li')?.querySelector(
                        'input, [role="checkbox"], [role="switch"], [class*="toggle"], [class*="switch"]'
                    );
                    if (toggle) {
                        if (isChecked(toggle)) {
                            return { method: 'sibling_already_checked', tag: toggle.tagName,
                                     text: pricingEl.textContent.trim().substring(0, 50),
                                     alreadyChecked: true };
                        }
                        toggle.click();
                        return { method: 'sibling_toggle', tag: toggle.tagName,
                                 text: pricingEl.textContent.trim().substring(0, 50),
                                 alreadyChecked: false };
                    }
                    // No toggle nearby — assume the Pricing text itself acts as a button.
                    // Don't click blindly here; let the caller fall through to other methods.
                }

                return null;
            }
            """)
            if clicked:
                _log(f"  Pricing option via JS method '{clicked['method']}': "
                     f"<{clicked['tag']}> text='{clicked['text']}' "
                     f"alreadyChecked={clicked.get('alreadyChecked')}")
                pricing_selected = True
        except Exception as e:
            _log(f"  JS pricing click error: {e}")

    # Method 3: Playwright locator approaches (only used if Methods 1/2 didn't already
    # discover the option was already checked).
    if not pricing_selected:
        for label_text in ['Pricing', 'Price', 'Prices', 'Include Pricing',
                           'Include Price', 'Show Pricing']:
            try:
                loc = page.locator(f'text="{label_text}"').first
                if loc.is_visible(timeout=2000):
                    loc.click(timeout=3000)
                    _log(f"  Clicked '{label_text}' via Playwright locator")
                    pricing_selected = True
                    break
            except Exception:
                continue

    # Method 4: get_by_role checkbox — `.check()` is idempotent (no-op if already checked),
    # so this is safe even when the box is selected by default.
    if not pricing_selected:
        try:
            cb = page.get_by_role("checkbox", name=re.compile(r"pric", re.IGNORECASE))
            if cb.count() > 0:
                cb.first.check(timeout=3000)
                _log("  Ensured pricing checked via get_by_role checkbox")
                pricing_selected = True
        except Exception:
            pass

    # Verification: after all the click methods, check whether a pricing-labelled
    # checkbox/toggle is now actually selected. If we somehow ended up un-checking it
    # (the original bug), try one more idempotent .check() pass.
    try:
        is_checked = page.evaluate("""
        () => {
            const modal = document.querySelector(
                '[role="dialog"], .modal, [class*="modal"], [class*="Modal"], ' +
                '[class*="dialog"], [class*="Dialog"], [aria-modal="true"]'
            ) || document.body;
            const inputs = modal.querySelectorAll(
                'input[type="checkbox"], input[type="radio"], ' +
                '[role="checkbox"], [role="switch"], [role="radio"]'
            );
            for (const inp of inputs) {
                const container = inp.closest('label, div, li, span, [class*="option"], [class*="Option"]');
                if (container && (container.textContent || '').toLowerCase().includes('pric')) {
                    if (inp.checked === true) return true;
                    const ac = inp.getAttribute && inp.getAttribute('aria-checked');
                    if (ac === 'true') return true;
                    return false;
                }
            }
            return null;  // no labelled control found — can't verify
        }
        """)
        if is_checked is False:
            _log("  Verification: pricing input is currently UNCHECKED — re-checking...")
            try:
                page.get_by_role("checkbox", name=re.compile(r"pric", re.IGNORECASE)).first.check(timeout=3000)
                _log("  Re-checked pricing via get_by_role")
            except Exception as e:
                _log(f"  Re-check failed: {e}")
        elif is_checked is True:
            _log("  Verification: pricing input is checked. Good.")
        else:
            _log("  Verification: no pricing-labelled checkbox found to verify.")
    except Exception as e:
        _log(f"  Verification step failed: {e}")

    # Method 5: AI RECOVERY — let AI find and click the Pricing option
    if not pricing_selected and ai_recover:
        _log("  All standard methods failed — using AI to find Pricing option...")
        try:
            ai_success = ai_recover(
                page,
                "I need to select the 'Pricing' option in this download modal. "
                "There should be a checkbox, toggle, or clickable option labeled "
                "'Pricing' or 'Price' in the Download Options section. "
                "Find it and click/check it so that pricing data is included in "
                "the CSV export. Look for any unchecked option related to pricing.",
                "US Foods order guide download modal"
            )
            if ai_success:
                _log("  AI successfully selected Pricing option")
                pricing_selected = True
            else:
                _log("  AI could not find Pricing option either")
        except Exception as e:
            _log(f"  AI recovery error: {e}")

    if not pricing_selected:
        _log("  CRITICAL: Could not find/select Pricing option — "
             "CSV WILL lack price columns. Modal HTML logged above for debugging.")
    else:
        _log("  Pricing option selected successfully")
    time.sleep(1)

    # ── Step 5: Click green Download button in modal to capture CSV ──
    # There are now TWO "Download" elements: the page-level link and the
    # modal button. The modal button is the LAST one in DOM order.
    _log("  Clicking modal Download button (capturing CSV)...")
    csv_text = None
    try:
        with page.expect_download(timeout=30000) as download_info:
            try:
                # The modal's Download button is the last "Download" text on page
                page.locator('text="Download"').last.click(timeout=10000)
            except Exception:
                try:
                    # Try button inside a modal/dialog
                    page.click('button:has-text("Download")', timeout=10000)
                except Exception:
                    # Last resort: any submit button
                    page.click('button[type="submit"]', timeout=10000)
        download = download_info.value
        suggested_name = download.suggested_filename
        _log(f"  CSV download captured: {suggested_name!r}")
        try:
            csv_path = download.path()
            if csv_path:
                with open(csv_path, 'r', encoding='utf-8', errors='replace') as f:
                    csv_text = f.read()
                _log(f"  Read {len(csv_text)} chars from {csv_path}")
        except Exception as e:
            _log(f"  Could not read download file: {e}")
    except Exception as e:
        _log(f"  Download capture failed: {e}")
        return []

    if not csv_text:
        _log("  No CSV content captured")
        return []

    # ── Step 6: Parse CSV ──
    # Column layout (confirmed from manual export 2026-05-01):
    #   Line Number, Group Name, Product Number, Product Description,
    #   Product Brand, Product Package Size, Customer Product Number,
    #   USF Class Description, Storage Description, [Price columns]
    items = []
    try:
        # Read the CSV twice: first to find candidate price columns by header name,
        # then (if none found) by sampling values for currency-shaped data.
        rows_buffered = list(_csv.DictReader(StringIO(csv_text)))
        headers = []
        if rows_buffered:
            # DictReader.fieldnames isn't accessible after iteration without re-reading,
            # so derive from the first row's keys.
            headers = list(rows_buffered[0].keys())
        elif csv_text:
            # CSV with header row only.
            first_line = csv_text.splitlines()[0] if csv_text.splitlines() else ''
            headers = [h.strip() for h in first_line.split(',')]
        _log(f"  CSV headers: {headers}")

        # Step 1: header-keyword match. Cover common US Foods column variants.
        # 'price', 'cost', 'amount', 'each' (per-each), 'rate', 'unit cost'.
        price_keywords = ('price', 'cost', 'amount', 'rate', 'unit cost', 'your price', 'case price', 'net')
        price_cols = [h for h in headers if h and any(k in h.lower() for k in price_keywords)]

        # Step 2: if no header matches, scan column values for currency shape ($1.23 or 1.23 with >=50% non-empty rows numeric).
        if not price_cols and rows_buffered:
            currency_re = re.compile(r'^\$?\s*\d+(?:\.\d{1,2})?\s*$')
            sample = rows_buffered[:20]
            for h in headers:
                if not h:
                    continue
                vals = [(r.get(h) or '').strip() for r in sample]
                non_empty = [v for v in vals if v]
                if not non_empty:
                    continue
                hits = sum(1 for v in non_empty if currency_re.match(v))
                if hits >= max(3, len(non_empty) // 2):
                    _log(f"  Inferring price column by value shape: {h!r} ({hits}/{len(non_empty)} numeric)")
                    price_cols.append(h)

        if not price_cols:
            _log("  WARNING: no price column found in CSV (neither by header keyword nor by value shape)")

        for row in rows_buffered:
            pid = (row.get('Product Number') or '').strip()
            if not pid:
                continue
            name = (row.get('Product Description') or '').strip()
            brand = (row.get('Product Brand') or '').strip()
            pack = (row.get('Product Package Size') or '').strip()
            category = (row.get('Group Name') or '').strip()
            price_val = None
            for col in price_cols:
                raw = (row.get(col) or '').strip()
                if not raw:
                    continue
                clean = re.sub(r'[^\d.\-]', '', raw)
                if not clean:
                    continue
                try:
                    price_val = float(clean)
                    if price_val > 0:
                        break
                except Exception:
                    continue
            items.append({
                'usfoodsId': pid,
                'name': name,
                'brand': brand,
                'pack': pack,
                'category': category,
                'price': price_val,
                'unit': 'CS',
                'lastOrdered': None,
            })
    except Exception as e:
        _log(f"  CSV parse error: {e}")
        return []

    with_price = [i for i in items if i.get('price')]
    _log(f"  Parsed {len(items)} items ({len(with_price)} with prices)")
    return items


# ── Navigate to Order Guide from Home Page (legacy DOM-scrape path) ────────
def _scrape_order_guide(page):
    """DOM-scrape fallback: navigate to order guide and extract items directly.

    Used when CSV download fails. Navigates to the order guide page and
    scrolls through all items, extracting product info via text regex.

    Updated 2026-05-01: US Foods uses standard HTML (NOT Ionic). Removed
    all ion-* selectors. Items show as product cards with brand, name,
    item number (#XXXXXXX), pack size, and price ($XX.XX cs).
    """
    _log("DOM scrape fallback — navigating to order guide...")

    # ── Step 1: Navigate to order guide ──
    # If the page crashed during CSV export, we need a fresh page.
    # Check if the current page is alive first.
    page_alive = True
    try:
        page.evaluate("1")
    except Exception as alive_err:
        _log(f"  Page is dead ({alive_err}) — creating fresh page")
        page_alive = False

    if not page_alive:
        try:
            context = page.context
            page.close()
            page = context.new_page()
            _log("  Created fresh page")
        except Exception as e:
            _log(f"  Could not create fresh page: {e}")
            return []

    guide_found = False
    try:
        _log("  Loading /desktop/home ...")
        page.goto("https://order.usfoods.com/desktop/home",
                   wait_until="domcontentloaded", timeout=30000)
        _log(f"  URL after goto: {page.url}")
    except PwTimeout:
        _log("  domcontentloaded timeout — continuing")
    except Exception as e:
        _log(f"  FAILED to load homepage: {e}")
        if "crash" in str(e).lower():
            return []

    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:
        _log("  networkidle timed out — page may still be usable")
    time.sleep(3)

    try:
        page.evaluate("1")
    except Exception as alive_err:
        if "crash" in str(alive_err).lower() or "target" in str(alive_err).lower():
            _log(f"  Page tab CRASHED after navigation: {alive_err}")
            return []
    try:
        _dismiss_popups(page)
    except Exception:
        pass

    # Sanity check
    final_url = page.url.lower()
    try:
        sanity_text = (page.inner_text('body') or '')[:6000].lower()
    except Exception:
        sanity_text = ''
    if '/search/browse' in final_url or (
        'become a customer' in sanity_text and 'log in' in sanity_text
    ):
        _log(f"  ABORT: page looks logged-out (URL: {page.url})")
        return []

    # ── Step 2: Find and click DD Mau Orderguide ──
    guide_selectors = [
        'a:has-text("DD Mau Orderguide")',
        'button:has-text("DD Mau Orderguide")',
        'a:has-text("DD Mau Order")',
        '[href*="lists/view"]',
        'a:has-text("Orderguide")',
    ]
    for sel in guide_selectors:
        try:
            el = page.query_selector(sel)
            if el and el.is_visible():
                _log(f"  Found order guide via {sel}")
                el.click(timeout=10000)
                guide_found = True
                break
        except Exception:
            continue

    # Playwright text search fallback
    if not guide_found:
        for search_text in ["DD Mau Orderguide", "DD Mau Order", "Orderguide"]:
            try:
                link = page.get_by_text(search_text, exact=False).first
                if link and link.is_visible():
                    link.click(timeout=10000)
                    _log(f"  Clicked via text search: '{search_text}'")
                    guide_found = True
                    break
            except Exception:
                continue

    # If homepage didn't have it, try /desktop/lists
    if not guide_found:
        _log("  Not found on homepage — trying /desktop/lists...")
        try:
            page.goto("https://order.usfoods.com/desktop/lists",
                      wait_until="domcontentloaded", timeout=30000)
            try:
                page.wait_for_load_state("networkidle", timeout=15000)
            except Exception:
                pass
            time.sleep(3)
            for sel in guide_selectors:
                try:
                    el = page.query_selector(sel)
                    if el and el.is_visible():
                        el.click(timeout=10000)
                        _log(f"  Clicked from lists page via {sel}")
                        guide_found = True
                        break
                except Exception:
                    continue
        except Exception as e:
            _log(f"  Failed to load lists: {e}")

    # JS fallback
    if not guide_found:
        try:
            clicked = page.evaluate("""
            () => {
                for (const el of document.querySelectorAll('a, button, [role="button"]')) {
                    const t = (el.textContent || '').trim().toLowerCase();
                    if (t.includes('dd mau') && t.includes('orderguide')
                        && el.offsetParent !== null) {
                        el.click();
                        return true;
                    }
                }
                return false;
            }
            """)
            if clicked:
                _log("  Clicked via JS fallback")
                guide_found = True
        except Exception as e:
            _log(f"  JS search error: {e}")

    # ── Step 3: Wait for order guide page to render ──
    if guide_found:
        try:
            page.wait_for_load_state("domcontentloaded", timeout=15000)
        except Exception:
            pass
        try:
            page.wait_for_load_state("networkidle", timeout=20000)
        except Exception:
            _log("  networkidle timed out on guide page — continuing")
        _dismiss_popups(page)
        time.sleep(3)
        _log(f"  Guide page URL: {page.url}")

        # Wait for product cards to render. The real page shows items
        # with product IDs (#XXXXXXX) and prices ($XX.XX).
        try:
            page.wait_for_selector(
                '[data-cy="pme-product-card"], .usf-pme-product-card, '
                '[class*="product-card"], [class*="product"]',
                timeout=15000)
            _log("  Product cards found on page!")
        except Exception:
            _log("  No product cards detected by selector — will try extraction anyway")

    # Check if items are visible even without clicking a specific guide
    if not guide_found:
        _log("  No guide link found — checking if items already visible...")
        try:
            body_text = page.inner_text('body') or ''
            product_ids = re.findall(r'#(\d{7})\b', body_text)
            price_matches = re.findall(r'\$\d+\.\d{2}', body_text)
            _log(f"  Current page: {len(set(product_ids))} product IDs, {len(price_matches)} prices")
            if len(set(product_ids)) >= 3 and len(price_matches) >= 3:
                _log("  Items visible — proceeding with extraction!")
                guide_found = True
        except Exception:
            pass

    # ── Extract items ──
    _log(f"  Final URL: {page.url}")

    try:
        body = page.inner_text('body') or ''
    except Exception as e:
        _log(f"  FATAL: Cannot read page body: {e}")
        return []

    # Count products header (e.g., "76 Products")
    prod_match = re.search(r'(\d{1,4})\s+Products?\b', body)
    if prod_match:
        _log(f"  Page shows {prod_match.group(1)} products")

    # Scroll to load all items
    item_count = _scroll_to_load_all(page)
    if item_count < 3:
        _log(f"  WARNING: Only {item_count} items found after scrolling")
        # Log full page for debugging
        try:
            for i in range(0, min(len(body), 3000), 500):
                chunk = body[i:i+500].replace('\n', ' | ')
                _log(f"  BODY[{i}:{i+500}]: {chunk}")
        except Exception:
            pass

    # Primary: JS DOM extraction
    items = _extract_items_js(page)

    with_price = [i for i in items if i.get("price") is not None]
    without_price = [i for i in items if i.get("price") is None]

    _log(f"  JS results: {len(with_price)} with prices, {len(without_price)} without")

    for item in with_price[:15]:
        _log(f"    {item['id']} | {item.get('name', '?')[:45]} | ${item.get('price', '?')} {item.get('unit', '?')} | {item.get('pack', '')}")

    if without_price:
        _log(f"  Items WITHOUT prices:")
        for item in without_price[:10]:
            raw_preview = item.get('raw', '')[:120].replace('\n', ' | ')
            _log(f"    {item['id']} | {item.get('name', '?')[:45]} | raw: {raw_preview}")

    results = []
    for item in with_price:
        entry = {
            "name": item["name"],
            "usfoodsId": item["id"],
            "price": item["price"],
            "pack": item.get("pack"),
            "brand": item.get("brand"),
            "unit": item.get("unit", "CS"),
            "lastOrdered": item.get("lastOrdered"),
        }
        if item.get("originalPrice") and item["originalPrice"] != item["price"]:
            entry["originalPrice"] = item["originalPrice"]
        results.append(entry)

    if not results and items:
        _log("  JS found 0 with prices — trying text fallback...")
        results = _extract_items_text_fallback(page)

    _log(f"  FINAL: {len(results)} items extracted with prices")
    return results


# ── Main entry point ─────────────────────────────────────────────────────────
def fetch_usfoods_prices(db):
    from firebase_admin import firestore as fs

    username = os.environ.get("USFOODS_USERNAME", "")
    gmail_address = os.environ.get("USFOODS_GMAIL", "")
    gmail_app_password = os.environ.get("USFOODS_GMAIL_APP_PASSWORD", "")

    if not username:
        _log("Skipping — USFOODS_USERNAME not set")
        _write_scrape_status(db, "error", "USFOODS_USERNAME env var not set")
        return

    if not gmail_address or not gmail_app_password:
        _log("Skipping — USFOODS_GMAIL or USFOODS_GMAIL_APP_PASSWORD not set")
        _write_scrape_status(db, "error", "Gmail credentials not set for 2FA code retrieval")
        return

    _log("=" * 55)
    _log("Starting US Foods order guide scrape...")
    _log("=" * 55)

    _write_scrape_status(db, "running", "Starting scrape...")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox", "--disable-setuid-sandbox",
                "--disable-dev-shm-usage", "--disable-gpu",
                "--disable-blink-features=AutomationControlled",
                "--disable-extensions",
                "--disable-background-networking",
                # Set V8 heap to 1024MB. The default on Railway's
                # container was too small for the Ionic-heavy
                # /desktop/lists page (76 product cards). 512 was
                # also too small. 1GB should be plenty.
                "--js-flags=--max-old-space-size=1024",
                "--disable-features=TranslateUI,BlinkGenPropertyTrees",
                "--disable-renderer-backgrounding",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
            ]
        )
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )

        # MEMORY OPTIMIZATION (2026-05-01): Block images/media/fonts and
        # third-party trackers. KEEP stylesheets — the Download modal
        # depends on Ionic's CSS for the click targets to be reachable.
        # Text-only flow doesn't need images, but the export-CSV flow
        # still needs the modal to actually render its buttons.
        def _block_heavy_resources(route, request):
            try:
                rt = request.resource_type
                if rt in ("image", "media", "font"):
                    route.abort()
                    return
                u = request.url.lower()
                blocked_hosts = (
                    "demdex.net", "doubleclick.net", "google-analytics.com",
                    "googletagmanager.com", "adobedtm.com", "omtrdc.net",
                    "adobe.com/b/ss", "facebook.net", "facebook.com/tr",
                    "hotjar.com", "fullstory.com", "mouseflow.com",
                    "newrelic.com", "nr-data.net", "bugsnag.com",
                    "sentry.io", "segment.io", "branch.io",
                )
                if any(h in u for h in blocked_hosts):
                    route.abort()
                    return
                route.continue_()
            except Exception:
                try:
                    route.continue_()
                except Exception:
                    pass

        try:
            context.route("**/*", _block_heavy_resources)
        except Exception as e:
            _log(f"  Could not install resource blocker: {e}")
        page = context.new_page()

        # Track whether a specific status (login_failed/no_prices) was already
        # written before raising. Without this, the broad except-handler below
        # would overwrite "login_failed"/"no_prices" with the generic "error"
        # status, and the portal — which keys its alert wording off
        # scrapeStatus.status === "login_failed"|"no_prices"|other — would
        # always show the generic "Scraper Error" headline. (Operations.jsx
        # lines 2983–2987.) Set this to True alongside any specific status
        # write so the broad handler can skip its overwrite.
        status_written = False

        try:
            # Login
            if not _login(page, username, gmail_address, gmail_app_password):
                _log("Login FAILED")
                _write_scrape_status(db, "login_failed",
                    "Could not log into US Foods. Check credentials and 2FA setup.")
                status_written = True
                browser.close()
                raise RuntimeError("US Foods login failed — 2FA code not received or credentials invalid")

            _log("Login successful — navigating to order guide...")
            _dismiss_popups(page)
            time.sleep(2)

            # Preferred path: download the CSV export (much lighter than
            # rendering 76 product cards). Falls back to DOM scrape if
            # the export modal can't be opened (e.g., US Foods removed
            # the Download button).
            items = _download_orderguide_csv(page)
            if not items:
                # Check if the session is still alive before trying the
                # heavier DOM scrape. If /desktop/lists already redirected
                # to /search/browse, the session is dead and the DOM scrape
                # will just crash the tab trying to load Ionic again.
                session_alive = True
                try:
                    cur_url = page.url.lower()
                    if '/search/browse' in cur_url or 'login' in cur_url:
                        _log("CSV path failed AND session looks dead "
                             f"(URL: {page.url[:100]}) — skipping DOM fallback")
                        session_alive = False
                except Exception:
                    pass
                if session_alive:
                    _log("CSV export path returned no items — trying DOM scrape fallback")
                    items = _scrape_order_guide(page)

            browser.close()

            if not items:
                _log("No items scraped from order guide")
                _write_scrape_status(db, "no_prices",
                    "Login succeeded but no items with prices found on Order Guide page.")
                status_written = True
                raise RuntimeError("US Foods scrape returned 0 items — order guide empty or session died")

            # Build prices dict
            prices = {}
            skipped = 0
            for item in items:
                if item.get("price") is None or item.get("price") == 0:
                    skipped += 1
                    continue
                key = item.get("usfoodsId") or item["name"].replace(" ", "_").lower()
                entry = {
                    "name": item["name"],
                    "price": item["price"],
                    "pack": item.get("pack"),
                    "brand": item.get("brand"),
                    "usfoodsId": item.get("usfoodsId"),
                    "unit": item.get("unit", "CS"),
                    "lastOrdered": item.get("lastOrdered"),
                    "lastUpdated": datetime.now(timezone.utc).isoformat(),
                }
                if item.get("originalPrice") and item["originalPrice"] != item["price"]:
                    entry["originalPrice"] = item["originalPrice"]
                prices[key] = entry

            if skipped:
                _log(f"  Skipped {skipped} items without prices")

            if not prices:
                _log("No items with prices found — NOT overwriting Firestore")
                _write_scrape_status(db, "no_prices",
                    f"Scraped {len(items)} items but none had valid prices")
                status_written = True
                raise RuntimeError(f"US Foods scraped {len(items)} items but 0 had valid prices")

            # Save to Firestore (merge to keep old prices)
            ct = _ct_now()
            existing_doc = db.collection("vendor_prices").document("usfoods").get()
            existing_prices = {}
            if existing_doc.exists:
                existing_prices = (existing_doc.to_dict() or {}).get("prices", {})

            merged = {**existing_prices, **prices}

            db.collection("vendor_prices").document("usfoods").set({
                "prices": merged,
                "lastScraped": ct.isoformat(),
                "totalItems": len(merged),
                "foundCount": len(prices),
                "newThisRun": len(prices),
                "keptFromPrevious": len(merged) - len(prices),
                "source": "order_guide",
                "timestamp": fs.SERVER_TIMESTAMP,
            })

            _log("=" * 55)
            _log(f"DONE — {len(prices)} items with prices this run")
            _log(f"  Total in Firestore: {len(merged)} (kept {len(merged) - len(prices)} from previous)")
            _log("=" * 55)

            _write_scrape_status(db, "success",
                f"Scraped {len(prices)} items with prices. Total: {len(merged)}.",
                prices_count=len(prices))

        except Exception as e:
            _log(f"FATAL ERROR: {e}")
            _log(f"Traceback: {traceback.format_exc()}")
            # Only write the generic "error" status if a more specific
            # status (login_failed / no_prices) wasn't already written.
            # Without this guard, the portal's alert wording always falls
            # through to "Scraper Error" because this overwrites the
            # specific status set just before the raise.
            if not status_written:
                _write_scrape_status(db, "error", f"Scraper crashed: {str(e)[:300]}")
            try:
                browser.close()
            except Exception:
                pass
            raise  # Re-raise so the main scraper loop knows it failed
