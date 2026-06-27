#!/usr/bin/env python3
"""
DD Mau print bridge — Flask service that turns HTTPS POSTs from the
DD Mau web app into raster prints on the Brother QL-820NWB.

────────────────────────────────────────────────────────────────────────
WHY THIS EXISTS
────────────────────────────────────────────────────────────────────────

The DD Mau web app at https://app.ddmaustl.com cannot directly print to
the Brother QL-820NWB at 192.168.1.34 because:
  1. Mixed content — browsers refuse HTTPS→HTTP fetches.
  2. iOS Share Sheet path works but requires manual taps every print.
  3. AirPrint guesses page dimensions wrong (label prints on full page).

This service runs on a Pi 5 on the same LAN as the Brother. The Pi has
a real HTTPS endpoint via Tailscale Funnel (Tailscale auto-manages a
Let's Encrypt cert for `<machine>.<tailnet>.ts.net`). The web app POSTs
sticker payloads to that HTTPS URL; the service renders them at the
exact label dimensions and sends them to the Brother via brother_ql's
TCP raster protocol.

────────────────────────────────────────────────────────────────────────
PAYLOAD CONTRACT
────────────────────────────────────────────────────────────────────────

POST /print/label
  X-API-Key: <key from /etc/print_bridge/api_key>
  Content-Type: application/json

  {
    "kind": "prep",                         // 'prep' or 'free_text'
    "lines": [                              // top-to-bottom render order
      {"text": "Garlic Aioli", "scale": 3.0, "bold": true},
      {"text": "By: Maria",    "scale": 1.5, "bold": false},
      {"text": "Prepped: 3pm", "scale": 1.5, "bold": false},
      {"text": "Expires: 5/29","scale": 1.5, "bold": true}
    ],
    "size":   {"widthMm": 62, "heightMm": 40},
    "copies": 1,
    "footer": "DD Mau"                       // optional small footer
  }

  Response: {"ok": true, "printedAt": "2026-05-22T20:14:33Z", "lines": 4}

POST /print/free-text
  X-API-Key: <key>
  Content-Type: application/json

  {
    "text":   "EXTRA CRISPY",
    "sizeMm": {"widthMm": 62, "heightMm": 25},
    "copies": 1
  }

  Response: same as /print/label.

GET /healthz
  No auth needed.

  Response: {
    "ok": true,
    "version": "1.0.0",
    "brother": {
      "ip": "192.168.1.34",
      "reachable": true,
      "checkedAt": "2026-05-22T20:14:33Z"
    }
  }

────────────────────────────────────────────────────────────────────────
DEPLOY
────────────────────────────────────────────────────────────────────────

Installed by setup.sh into /opt/print_bridge/print_server.py with a
systemd unit at /etc/systemd/system/print_server.service. Auto-starts
on boot, auto-restarts on crash, logs to journald.

  • Start:   sudo systemctl start print_server
  • Status:  sudo systemctl status print_server
  • Logs:    sudo journalctl -u print_server -f
  • Restart: sudo systemctl restart print_server
"""

import io
import os
import json
import socket
import logging
import datetime
import subprocess
from pathlib import Path

from flask import Flask, request, jsonify
from PIL import Image, ImageDraw, ImageFont

from brother_ql.conversion import convert
from brother_ql.raster import BrotherQLRaster
from brother_ql.backends.helpers import send

# ──────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────

VERSION = "1.0.0"

# The Brother lives at this fixed IP. Pin it via DHCP reservation on
# the router so it never drifts. If the printer moves, edit /etc/
# print_bridge/config.json (see setup.sh) — don't bake new IPs into
# this file.
DEFAULT_BROTHER_IP = "192.168.1.34"
# brother_ql is picky about model strings — it knows "QL-820NWB" (Andrew's
# actual unit) but NOT "QL-820NW" (a different printer without Bluetooth).
# An invalid model id throws BrotherQLUnknownModel and the print silently
# fails with an empty error. Confirmed 2026-05-22 via journalctl trace.
DEFAULT_BROTHER_MODEL = "QL-820NWB"
DEFAULT_LABEL_TYPE = "62"            # 62mm continuous tape (DK-2205 / DK-4205)
DEFAULT_DPI = 300                    # Brother QL-820 supports 300 DPI native

CONFIG_PATH = Path("/etc/print_bridge/config.json")
API_KEY_PATH = Path("/etc/print_bridge/api_key")
# The service runs hardened (ProtectSystem=strict → /etc is read-only to it), so
# the self-heal can't write back to config.json. systemd's StateDirectory gives
# us one writable spot (/var/lib/print_bridge) to remember the last IP we
# actually reached the Brother at, so a restart starts from the learned address.
STATE_DIR = Path(os.environ.get("STATE_DIRECTORY", "/var/lib/print_bridge"))
LEARNED_IP_PATH = STATE_DIR / "brother_ip"

# Conversion factor for 300 DPI: 1 mm = 11.811 px. Brother QL series
# accepts specific pixel widths for each tape — for 62mm continuous,
# the printable raster is 696 px wide (NOT the full 732 px / 62 mm,
# because the printable area leaves a small margin on each side).
PIXELS_PER_MM = 11.811
BROTHER_PRINTABLE_WIDTH_PX = {
    "62": 696,    # 62mm continuous
    "29": 306,    # 29mm continuous (not used here, but kept for reference)
    "12": 106,    # 12mm continuous
}


def load_config():
    """Read the local config file. Missing keys fall back to defaults."""
    cfg = {
        "brother_ip": DEFAULT_BROTHER_IP,
        "brother_model": DEFAULT_BROTHER_MODEL,
        "label_type": DEFAULT_LABEL_TYPE,
    }
    if CONFIG_PATH.exists():
        try:
            with CONFIG_PATH.open() as f:
                cfg.update(json.load(f))
        except Exception as e:
            logging.warning(f"Failed to read {CONFIG_PATH}: {e} — using defaults")
    # A previously-learned IP (from an mDNS self-heal) wins over the static
    # config — it's the most recently confirmed-reachable address for the Brother.
    try:
        if LEARNED_IP_PATH.exists():
            learned = LEARNED_IP_PATH.read_text().strip()
            if learned.count(".") == 3:
                cfg["brother_ip"] = learned
    except Exception:
        pass
    return cfg


def load_api_key():
    """Read the API key from disk. Returns None if not set (and the server
    will then refuse every request, which is the safe default)."""
    if API_KEY_PATH.exists():
        try:
            key = API_KEY_PATH.read_text().strip()
            return key if key else None
        except Exception:
            return None
    return None


CFG = load_config()
API_KEY = load_api_key()


# ──────────────────────────────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("print_bridge")


# ──────────────────────────────────────────────────────────────────────
# Auth
# ──────────────────────────────────────────────────────────────────────

def require_api_key():
    """Reject the request if X-API-Key doesn't match. Returns None on
    success, or (response, status) on failure."""
    if not API_KEY:
        log.error("API_KEY not configured — refusing all requests")
        return jsonify({"ok": False, "error": "server_misconfigured"}), 503
    supplied = request.headers.get("X-API-Key", "")
    if not supplied or supplied != API_KEY:
        log.warning(f"Auth rejected from {request.remote_addr}")
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    return None


# ──────────────────────────────────────────────────────────────────────
# Brother health
# ──────────────────────────────────────────────────────────────────────

def _tcp_open(ip, port=9100, timeout=0.5):
    """True if we can open a TCP connection to ip:port within `timeout`s."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((ip, port))
        return True
    except (socket.timeout, OSError):
        return False
    finally:
        try:
            sock.close()
        except Exception:
            pass


def discover_brother_ip(timeout=2.0):
    """Find the Brother on the LAN via mDNS (avahi). The QL-820NWB advertises
    _pdl-datastream._tcp with a hostname like BRWxxxxxxxxxxxx.local. Returns the
    first reachable BRW* host's IPv4, or None. Bounded so /healthz stays snappy.

    This is the self-heal for DHCP drift: if the router hands the printer a new
    IP, we find it by name instead of staying pinned to a stale address."""
    try:
        out = subprocess.run(
            ["avahi-browse", "-rpt", "_pdl-datastream._tcp"],
            capture_output=True, text=True, timeout=timeout,
        ).stdout
    except Exception as e:
        log.warning(f"mDNS discovery unavailable: {e}")
        return None
    # Resolved parseable lines: =;iface;IPv4;name;type;domain;HOST.local;ADDR;PORT;txt
    for line in out.splitlines():
        if not line.startswith("="):
            continue
        parts = line.split(";")
        if len(parts) < 8 or parts[2] != "IPv4":
            continue
        host, ip = parts[6], parts[7]
        # Only adopt a Brother (BRW prefix) — never some other network printer.
        if host.upper().startswith("BRW") and ip.count(".") == 3:
            return ip
    return None


def persist_brother_ip(ip):
    """Remember a rediscovered IP in the writable state dir so it survives a
    restart. Best-effort — if the dir isn't writable, in-memory adoption still
    works (the next /healthz probe re-discovers)."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        LEARNED_IP_PATH.write_text(ip + "\n")
        log.info(f"Remembered Brother IP {ip}")
    except Exception as e:
        log.debug(f"Could not remember Brother IP (in-memory only): {e}")


def check_brother_reachable():
    """Quick TCP connect test to the Brother on port 9100 (raster). If the
    configured IP is down, SELF-HEAL: rediscover the printer by mDNS (it likely
    moved via DHCP) and adopt the new IP in-memory + persist it. Returns
    True/False. Normal case (configured IP up) is a single 500ms check — the
    mDNS path only runs when the static IP fails."""
    if _tcp_open(CFG["brother_ip"]):
        return True
    found = discover_brother_ip()
    if found and found != CFG["brother_ip"] and _tcp_open(found):
        log.warning(f"Brother moved {CFG['brother_ip']} -> {found} (DHCP drift) — adopting")
        CFG["brother_ip"] = found
        persist_brother_ip(found)
        return True
    return False


# ──────────────────────────────────────────────────────────────────────
# Renderer
# ──────────────────────────────────────────────────────────────────────

def mm_to_px(mm, dpi=DEFAULT_DPI):
    return int(round(mm * dpi / 25.4))


def get_font(size_px, bold=False):
    """Find a usable TTF on the Pi. DejaVu ships with Raspberry Pi OS and
    works fine. We fall back to PIL's default bitmap font (which is
    tiny) if nothing else is available — the label will still print
    but it'll look bad."""
    candidates_bold = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    candidates_regular = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for path in (candidates_bold if bold else candidates_regular):
        if os.path.exists(path):
            return ImageFont.truetype(path, size_px)
    log.warning("No TrueType font found — falling back to PIL default")
    return ImageFont.load_default()


def render_label(payload):
    """Render the payload to a PIL image at the exact label dimensions.

    Layout: lines render top-to-bottom, vertically centered as a block.
    Each line is horizontally centered. Font size = base_font_px * scale.
    """
    size = payload.get("size", {})
    width_mm = float(size.get("widthMm", 62))
    height_mm = float(size.get("heightMm", 40))

    # Lock width to Brother's printable raster for the 62mm tape — the
    # printer expects exactly 696 px wide regardless of label size. We
    # render at that width and only height varies. (For non-62 tapes
    # we'd swap to a different printable-width constant.)
    width_px = BROTHER_PRINTABLE_WIDTH_PX.get(CFG["label_type"], 696)

    # Height in pixels follows the requested mm at 300 DPI.
    height_px = mm_to_px(height_mm)

    # 'L' = 8-bit grayscale. brother_ql wants either RGB or '1' (1-bit);
    # we'll convert at the end. Grayscale lets us anti-alias text.
    img = Image.new("L", (width_px, height_px), color=255)
    draw = ImageDraw.Draw(img)

    lines = payload.get("lines", [])
    if not lines:
        # Empty payload — render a placeholder so the print isn't silently
        # blank. Helps debugging.
        draw.text((10, 10), "(empty label)", fill=0, font=get_font(40))
    else:
        # Compute total block height for vertical centering.
        # Base font size = label height / 6, scaled per line.
        base_font_px = max(int(height_px / 6), 18)

        rendered = []
        for line in lines:
            text = str(line.get("text", "")).strip()
            scale = float(line.get("scale", 1.0))
            bold = bool(line.get("bold", False))
            if not text:
                continue
            font_px = max(int(base_font_px * scale), 12)
            font = get_font(font_px, bold=bold)
            # Use textbbox to measure actual rendered size.
            bbox = draw.textbbox((0, 0), text, font=font)
            w = bbox[2] - bbox[0]
            h = bbox[3] - bbox[1]
            rendered.append({"text": text, "font": font, "w": w, "h": h, "bbox": bbox})

        # Vertical centering — total height of all lines + small gaps.
        line_gap = max(int(base_font_px * 0.15), 4)
        total_h = sum(r["h"] for r in rendered) + line_gap * max(len(rendered) - 1, 0)
        y = max(int((height_px - total_h) / 2), 4)

        # Draw each line.
        for r in rendered:
            x = max(int((width_px - r["w"]) / 2), 4)
            # textbbox returns offsets from origin; subtract them so text
            # lands flush at (x, y) instead of below it.
            draw.text((x - r["bbox"][0], y - r["bbox"][1]), r["text"], fill=0, font=r["font"])
            y += r["h"] + line_gap

    # Optional footer — small text at the bottom edge.
    footer = payload.get("footer")
    if footer:
        footer_font = get_font(max(int(height_px / 14), 14))
        bbox = draw.textbbox((0, 0), footer, font=footer_font)
        fw = bbox[2] - bbox[0]
        fh = bbox[3] - bbox[1]
        fx = max(int((width_px - fw) / 2), 4)
        fy = height_px - fh - 8
        draw.text((fx - bbox[0], fy - bbox[1]), footer, fill=120, font=footer_font)

    # Brother raster expects 1-bit (black/white) at the end. Convert
    # via dither so anti-aliased edges still look smooth.
    img_1bit = img.convert("1", dither=Image.FLOYDSTEINBERG)
    return img_1bit


def send_to_brother(image, copies=1):
    """Convert a PIL image to Brother raster and send it via TCP."""
    qlr = BrotherQLRaster(CFG["brother_model"])
    qlr.exception_on_warning = True
    images = [image] * max(int(copies), 1)
    instructions = convert(
        qlr=qlr,
        images=images,
        label=CFG["label_type"],
        rotate="0",
        threshold=70.0,
        dither=False,         # we already dithered in PIL
        compress=False,
        red=False,
        dpi_600=False,
        hq=True,
        cut=True,             # auto-cut between copies (continuous tape)
    )
    send(
        instructions=instructions,
        printer_identifier=f"tcp://{CFG['brother_ip']}",
        backend_identifier="network",
        blocking=True,
    )


# ──────────────────────────────────────────────────────────────────────
# Endpoints
# ──────────────────────────────────────────────────────────────────────

app = Flask(__name__)


# ── CORS ───────────────────────────────────────────────────────────────
#
# The DD Mau web app at https://app.ddmaustl.com hits this service at
# https://<machine>.<tailnet>.ts.net — different origins, so the browser
# enforces CORS preflight. Without these headers, curl works fine
# (curl ignores CORS) but the web app silently falls back to the
# iOS share-sheet path because the browser blocks the fetch.
#
# Andrew confirmed this exact symptom 2026-05-22 — curl prints
# successfully, app shows share sheet.

ALLOWED_ORIGINS = {
    "https://app.ddmaustl.com",
    "http://localhost:5173",    # vite dev
    "https://localhost:5173",
    # Native app WebView origins (Capacitor). The iOS app serves the local
    # bundle from capacitor://localhost; Android (androidScheme:'https') from
    # https://localhost. WITHOUT these, the iPad/phone app's fetch() to the
    # bridge is CORS-blocked and it silently falls back to the AirPrint share
    # sheet — even when the bridge + printer are perfectly healthy.
    "capacitor://localhost",
    "https://localhost",
    "ionic://localhost",        # older Capacitor/Ionic builds
}


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin", "")
    if origin in ALLOWED_ORIGINS:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-API-Key"
        response.headers["Access-Control-Max-Age"] = "86400"
    return response


# Explicit OPTIONS handlers for the routes the web app calls. Flask's
# default behavior is to 405 OPTIONS on routes that only registered
# GET/POST, which fails preflight. Returning 204 with the CORS headers
# (added by the after_request hook above) is the standard fix.
@app.route("/print/label", methods=["OPTIONS"])
@app.route("/print/free-text", methods=["OPTIONS"])
@app.route("/healthz", methods=["OPTIONS"])
def cors_preflight():
    return ("", 204)


@app.errorhandler(Exception)
def handle_unexpected(e):
    log.exception(f"Unhandled error in {request.path}")
    return jsonify({"ok": False, "error": "internal_error", "detail": str(e)}), 500


@app.route("/healthz", methods=["GET"])
def healthz():
    # Run the check FIRST — it may self-heal CFG['brother_ip'] via mDNS — so the
    # reported ip reflects the address we actually reached (not the stale one).
    reachable = check_brother_reachable()
    return jsonify({
        "ok": True,
        "version": VERSION,
        "brother": {
            "ip": CFG["brother_ip"],
            "model": CFG["brother_model"],
            "label_type": CFG["label_type"],
            "reachable": reachable,
            "checkedAt": datetime.datetime.utcnow().isoformat() + "Z",
        },
        "auth_configured": bool(API_KEY),
    })


@app.route("/print/label", methods=["POST"])
def print_label():
    auth_err = require_api_key()
    if auth_err is not None:
        return auth_err

    try:
        payload = request.get_json(force=True, silent=False) or {}
    except Exception as e:
        return jsonify({"ok": False, "error": "bad_json", "detail": str(e)}), 400

    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "payload_must_be_object"}), 400

    lines = payload.get("lines", [])
    if not isinstance(lines, list):
        return jsonify({"ok": False, "error": "lines_must_be_array"}), 400

    copies = int(payload.get("copies", 1))
    if copies < 1 or copies > 20:
        return jsonify({"ok": False, "error": "copies_out_of_range",
                        "detail": "Must be 1–20."}), 400

    if not check_brother_reachable():
        return jsonify({"ok": False, "error": "brother_unreachable",
                        "detail": f"Could not connect to {CFG['brother_ip']}:9100"}), 502

    try:
        img = render_label(payload)
        send_to_brother(img, copies=copies)
    except Exception as e:
        log.exception("Print failed")
        return jsonify({"ok": False, "error": "print_failed", "detail": str(e)}), 500

    log.info(f"Printed {copies} label(s), {len(lines)} line(s)")
    return jsonify({
        "ok": True,
        "printedAt": datetime.datetime.utcnow().isoformat() + "Z",
        "lines": len(lines),
        "copies": copies,
    })


@app.route("/print/free-text", methods=["POST"])
def print_free_text():
    """Convenience endpoint for ad-hoc one-line labels. Transforms to the
    standard render path."""
    auth_err = require_api_key()
    if auth_err is not None:
        return auth_err

    try:
        body = request.get_json(force=True, silent=False) or {}
    except Exception as e:
        return jsonify({"ok": False, "error": "bad_json", "detail": str(e)}), 400

    text = str(body.get("text", "")).strip()
    if not text:
        return jsonify({"ok": False, "error": "text_required"}), 400

    size = body.get("sizeMm", {"widthMm": 62, "heightMm": 25})
    copies = int(body.get("copies", 1))

    payload = {
        "kind": "free_text",
        "lines": [{"text": text, "scale": 3.0, "bold": True}],
        "size": size,
        "copies": copies,
    }

    if not check_brother_reachable():
        return jsonify({"ok": False, "error": "brother_unreachable"}), 502

    try:
        img = render_label(payload)
        send_to_brother(img, copies=copies)
    except Exception as e:
        log.exception("Free-text print failed")
        return jsonify({"ok": False, "error": "print_failed", "detail": str(e)}), 500

    log.info(f"Printed free-text label x{copies}: {text!r}")
    return jsonify({"ok": True, "printedAt": datetime.datetime.utcnow().isoformat() + "Z",
                    "copies": copies})


@app.route("/", methods=["GET"])
def root():
    """Friendly index for humans who hit the URL in a browser."""
    return jsonify({
        "name": "DD Mau Print Bridge",
        "version": VERSION,
        "endpoints": ["/healthz", "/print/label", "/print/free-text"],
    })


if __name__ == "__main__":
    # When run directly (development), listen on plain HTTP. In
    # production the systemd unit runs us via gunicorn behind
    # Tailscale Funnel's HTTPS layer, which handles the cert.
    port = int(os.environ.get("PRINT_BRIDGE_PORT", "8443"))
    log.info(f"Starting print bridge on 0.0.0.0:{port} — version {VERSION}")
    log.info(f"Brother target: {CFG['brother_ip']} ({CFG['brother_model']}, label {CFG['label_type']})")
    log.info(f"Auth: {'configured' if API_KEY else 'NOT CONFIGURED (refusing all writes)'}")
    app.run(host="0.0.0.0", port=port, debug=False)
