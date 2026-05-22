#!/usr/bin/env bash
# DD Mau Pi 5 — one-shot setup for the print bridge + Tailscale HTTPS
# + Chromium kiosk for the media TV display.
#
# Run ONCE after first boot, as the regular `ddmau` user (NOT root —
# the script uses sudo where it needs to):
#
#   curl -fsSL https://example/setup.sh -o setup.sh   # or scp it over
#   chmod +x setup.sh
#   ./setup.sh
#
# Idempotent — safe to re-run. Skips steps that are already done.
#
# What it does, in order:
#   1. apt update + upgrade
#   2. install python3, pip, pillow, brother_ql, flask, gunicorn
#   3. install Tailscale (official installer)
#   4. drop print_server.py + print_server.service into the right paths
#   5. create print_bridge system user (sandboxed)
#   6. generate a random API key into /etc/print_bridge/api_key
#   7. write /etc/print_bridge/config.json (Brother IP, model, label)
#   8. enable + start the print_server systemd unit
#   9. set up Chromium kiosk autostart for the media TV URL
#  10. disable screen blanking
#  11. print the API key + Tailscale auth URL + Tailscale Funnel
#      command at the end for the operator to act on
#
# AFTER this script, the operator must (in order, takes ~5 min):
#   • Run `sudo tailscale up` and click the auth URL
#   • In the Tailscale admin console, enable HTTPS + Funnel for the
#     tailnet (one-time, lives at https://login.tailscale.com/admin/dns)
#   • Run `sudo tailscale funnel 8443` to expose the print bridge
#   • Paste the printed API key into the DD Mau Firestore at
#     /config/print_bridge.apiKey
#   • Paste the Tailscale hostname into /config/print_bridge.url

set -euo pipefail

# ── colors for human-readable output ─────────────────────────────────
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
BLUE=$'\033[0;34m'
NC=$'\033[0m'

step() { printf "${BLUE}==>${NC} %s\n" "$1"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
err()  { printf "${RED}✗${NC} %s\n" "$1"; }

# ── sanity checks ────────────────────────────────────────────────────

if [[ "$(id -u)" == "0" ]]; then
    err "Run this script as the ddmau user (not root). It uses sudo when needed."
    exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
    err "sudo is required. This script expects Raspberry Pi OS."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 1. system update ────────────────────────────────────────────────

step "Updating system packages (5–8 min on first run)"
sudo apt update -y
sudo apt upgrade -y
ok "System up to date"

# ── 2. python + library dependencies ────────────────────────────────

step "Installing Python + label printing libraries"
sudo apt install -y python3 python3-venv python3-pip \
    python3-pil python3-flask \
    fonts-dejavu fonts-liberation \
    libopenjp2-7 \
    chromium unclutter xdotool

# Create the venv first time
sudo mkdir -p /opt/print_bridge
sudo chown "$(id -u):$(id -g)" /opt/print_bridge
if [[ ! -d /opt/print_bridge/venv ]]; then
    python3 -m venv /opt/print_bridge/venv
fi

# Install the Python deps into the venv
/opt/print_bridge/venv/bin/pip install --upgrade pip
/opt/print_bridge/venv/bin/pip install flask pillow brother_ql

ok "Python dependencies installed"

# ── 3. install Tailscale ────────────────────────────────────────────

step "Installing Tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sudo bash
    ok "Tailscale installed"
else
    ok "Tailscale already installed"
fi

# ── 4. drop the print server code into place ────────────────────────

step "Installing print_server.py and systemd unit"

if [[ ! -f "$SCRIPT_DIR/print_server.py" ]]; then
    err "print_server.py not found next to setup.sh"
    err "Run this script from the pi5-print-bridge/ directory."
    exit 1
fi

sudo cp "$SCRIPT_DIR/print_server.py" /opt/print_bridge/print_server.py
sudo chmod 755 /opt/print_bridge/print_server.py

sudo cp "$SCRIPT_DIR/print_server.service" /etc/systemd/system/print_server.service
sudo chmod 644 /etc/systemd/system/print_server.service

ok "Print server files in place"

# ── 5. create the print_bridge system user ──────────────────────────

step "Creating sandboxed print_bridge user"
if ! id print_bridge >/dev/null 2>&1; then
    sudo useradd --system --no-create-home --shell /usr/sbin/nologin print_bridge
    ok "Created print_bridge user"
else
    ok "print_bridge user already exists"
fi

# Give the venv to the print_bridge user
sudo chown -R print_bridge:print_bridge /opt/print_bridge

# ── 6. config dir + API key ─────────────────────────────────────────

step "Generating API key and config"
sudo mkdir -p /etc/print_bridge

# Generate a fresh API key only if one doesn't exist (re-runs preserve key).
if [[ ! -f /etc/print_bridge/api_key ]]; then
    # 32 random bytes -> 64 hex chars. /dev/urandom is fine here.
    API_KEY="$(head -c 32 /dev/urandom | xxd -p -c 64)"
    echo -n "$API_KEY" | sudo tee /etc/print_bridge/api_key > /dev/null
    ok "Generated new API key"
else
    API_KEY="$(sudo cat /etc/print_bridge/api_key)"
    ok "Re-using existing API key (delete /etc/print_bridge/api_key to rotate)"
fi

# Lock down — only print_bridge user can read it.
sudo chown print_bridge:print_bridge /etc/print_bridge/api_key
sudo chmod 600 /etc/print_bridge/api_key

# Default config — Brother IP. Edit /etc/print_bridge/config.json
# directly if the printer ever moves.
if [[ ! -f /etc/print_bridge/config.json ]]; then
    cat <<'EOF' | sudo tee /etc/print_bridge/config.json > /dev/null
{
  "brother_ip": "192.168.1.34",
  "brother_model": "QL-820NW",
  "label_type": "62"
}
EOF
    ok "Wrote default config"
else
    ok "Config already exists (preserving)"
fi

sudo chown print_bridge:print_bridge /etc/print_bridge/config.json
sudo chmod 644 /etc/print_bridge/config.json

# ── 7. enable + start the service ───────────────────────────────────

step "Enabling and starting print_server"
sudo systemctl daemon-reload
sudo systemctl enable print_server
sudo systemctl restart print_server

# Give it a sec to boot, then check.
sleep 2
if sudo systemctl is-active print_server >/dev/null; then
    ok "print_server is running"
else
    err "print_server failed to start — check: sudo journalctl -u print_server -n 50"
fi

# ── 8. Chromium kiosk autostart (media TV) ──────────────────────────

step "Setting up Chromium kiosk for the media TV"

# Where to autostart desktop apps for the current user
AUTOSTART_DIR="$HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"

# Default media TV URL — edit to whatever your media display URL is.
# Could be a YouTube playlist, a Firebase-Storage HTML page, or
# (most likely for DD Mau) a route in the dd-mau-portal like
# https://app.ddmaustl.com/?display=media&loc=webster
MEDIA_URL="${MEDIA_URL:-https://app.ddmaustl.com/?display=media}"

cat > "$AUTOSTART_DIR/media-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=DD Mau Media Display
Exec=/usr/bin/chromium --kiosk --noerrdialogs --disable-infobars --check-for-update-interval=31536000 --incognito ${MEDIA_URL}
X-GNOME-Autostart-enabled=true
EOF

# Disable screen blanking via lxsession autostart
LX_AUTOSTART="$HOME/.config/lxsession/LXDE-pi/autostart"
mkdir -p "$(dirname "$LX_AUTOSTART")"
touch "$LX_AUTOSTART"

# Add the no-blank lines only if not already present
grep -q "@xset s off"       "$LX_AUTOSTART" || echo "@xset s off"          >> "$LX_AUTOSTART"
grep -q "@xset -dpms"       "$LX_AUTOSTART" || echo "@xset -dpms"          >> "$LX_AUTOSTART"
grep -q "@xset s noblank"   "$LX_AUTOSTART" || echo "@xset s noblank"      >> "$LX_AUTOSTART"
grep -q "@unclutter -idle"  "$LX_AUTOSTART" || echo "@unclutter -idle 1 -root" >> "$LX_AUTOSTART"

ok "Chromium kiosk + screen-blanking disabled"
ok "Media TV URL: $MEDIA_URL"
warn "Edit $AUTOSTART_DIR/media-kiosk.desktop to change the media URL"

# ── 9. report ──────────────────────────────────────────────────────

GREEN_BAR="==========================================================="

echo ""
echo "$GREEN_BAR"
printf "${GREEN} SETUP COMPLETE${NC}\n"
echo "$GREEN_BAR"
echo ""
printf "API KEY  : ${YELLOW}%s${NC}\n" "$API_KEY"
echo ""
echo "→ Paste this into the DD Mau Firestore at:"
echo "    /config/print_bridge.apiKey"
echo ""
echo "$GREEN_BAR"
printf "${YELLOW} NEXT STEPS${NC} (one-time, 5 min):\n"
echo "$GREEN_BAR"
echo ""
echo "1. Authenticate Tailscale:"
echo "     sudo tailscale up"
echo "   Click the auth URL on your Mac, approve."
echo ""
echo "2. In the Tailscale admin console, enable HTTPS + Funnel:"
echo "     https://login.tailscale.com/admin/dns      (enable HTTPS)"
echo "     https://login.tailscale.com/admin/funnel   (enable for this device)"
echo ""
echo "3. Expose the print bridge to the internet:"
echo "     sudo tailscale funnel 8443"
echo "   This prints your public URL — copy it."
echo ""
echo "4. Paste the Tailscale URL into the DD Mau Firestore at:"
echo "     /config/print_bridge.url"
echo ""
echo "5. Test from anywhere:"
echo "     curl https://<your-tailscale-hostname>/healthz"
echo ""
echo "$GREEN_BAR"
printf "${BLUE} TROUBLESHOOTING${NC}\n"
echo "$GREEN_BAR"
echo ""
echo "  Print server status   : sudo systemctl status print_server"
echo "  Print server logs     : sudo journalctl -u print_server -f"
echo "  Test Brother reach    : ping 192.168.1.34"
echo "  Restart print server  : sudo systemctl restart print_server"
echo "  Re-run this script    : ./setup.sh   (safe to re-run)"
echo ""
echo "$GREEN_BAR"
