# DD Mau Pi 5 Print Bridge — Setup Runbook

A small Flask service running on a Raspberry Pi 5 that lets the DD Mau
web app print labels on the Brother QL-820NWB via HTTPS. Solves the
mixed-content + AirPrint-page-size problems we hit with direct browser
printing.

## What this directory contains

| File | What it is |
|------|------------|
| `print_server.py` | Flask app — HTTPS endpoints, payload validation, brother_ql raster sender |
| `print_server.service` | systemd unit — auto-start on boot, auto-restart on crash |
| `setup.sh` | One-shot installer for a fresh Pi 5 — idempotent |
| `README.md` | This file |

## First-time install (on the Pi)

1. **SSH into the Pi from your Mac** (already done — see [main setup checklist](#)):
   ```
   ssh ddmau@ddmau-pi5.local
   ```

2. **Copy this directory to the Pi.** From your Mac in the dd-mau-portal repo root:
   ```
   scp -r pi5-print-bridge ddmau@ddmau-pi5.local:~/
   ```

3. **Run the setup script:**
   ```
   cd ~/pi5-print-bridge
   ./setup.sh
   ```
   Takes 5–10 minutes. Mostly waiting on apt + pip.

4. **At the end**, the script prints a yellow API key. **Copy it.**

5. **Authenticate Tailscale:**
   ```
   sudo tailscale up
   ```
   It prints a URL. Open that URL on your Mac and click "Approve."

6. **In the Tailscale admin console** (one-time per tailnet):
   - Enable HTTPS: <https://login.tailscale.com/admin/dns> → toggle "MagicDNS" + "HTTPS Certificates"
   - Enable Funnel: <https://login.tailscale.com/admin/funnel> → check the box for this device

7. **Expose the print bridge to the public internet:**
   ```
   sudo tailscale funnel 8443
   ```
   This prints your public URL (e.g. `https://ddmau-pi5.tail123abc.ts.net`). **Copy it.**

8. **Configure the DD Mau web app** — open the Firestore console and edit `/config/print_bridge`:
   ```
   {
     "enabled": true,
     "url": "https://ddmau-pi5.tail123abc.ts.net",
     "apiKey": "<paste the API key here>",
     "healthCheckTimeoutMs": 800
   }
   ```

9. **Test from your Mac:**
   ```
   curl https://ddmau-pi5.tail123abc.ts.net/healthz
   ```
   Should return `{"ok":true,"version":"1.0.0","brother":{"reachable":true,...}}`.

10. **Test print** — in the DD Mau web app, open Date Stickers → make a sticker → tap Print. A label should come out in ~2 seconds.

## Health checks

| Check | Command |
|-------|---------|
| Print server alive? | `sudo systemctl status print_server` |
| Tail print server logs | `sudo journalctl -u print_server -f` |
| Brother reachable? | `ping 192.168.1.34` |
| Tailscale connected? | `tailscale status` |
| Funnel exposed? | `tailscale funnel status` |
| Health endpoint | `curl http://localhost:8443/healthz` |

## When something breaks

### "Brother unreachable" in healthz response
1. `ping 192.168.1.34` from the Pi — if no ping, the Brother is off or moved to a new IP.
2. Check your router admin page → find the Brother in DHCP clients → confirm its current IP.
3. If the IP changed, edit `/etc/print_bridge/config.json` (`brother_ip`) and:
   ```
   sudo systemctl restart print_server
   ```
4. To prevent this in future: set a **DHCP reservation** for the Brother in your router so its IP never drifts.

### Service won't start (`systemctl status print_server` shows failed)
1. `sudo journalctl -u print_server -n 50` — read the last 50 log lines.
2. Most common cause: `brother_ql` import failure → re-run `setup.sh` to repair the venv.
3. Next most common: `/etc/print_bridge/api_key` missing → re-run `setup.sh`.

### Web app's "Test print" button reports "bridge unreachable"
1. Is the Pi powered on?
2. Is Tailscale running? `tailscale status` should show `<your-machine-name> online`.
3. Is Funnel up? `tailscale funnel status` should show port 8443 mapped to your hostname.
4. Does `/config/print_bridge.url` in Firestore match your actual Tailscale hostname?
5. Try `curl https://<your-tailscale-hostname>/healthz` from your Mac.

### Labels print but look wrong (wrong size, off-center, blank)
1. Check `/etc/print_bridge/config.json` — `label_type` should be `"62"` for the standard DK-2205 / DK-4205 tape.
2. The web app payload's `size.widthMm` should match the tape (62mm for the default tape). If it sends a different width, the print will render correctly but cut wrong — the server always uses the tape's printable width (696 px for 62mm tape).
3. Empty labels → the `lines` array was empty in the payload. Check the web app's payload via the Network tab.

### API key compromised / rotate
```
sudo rm /etc/print_bridge/api_key
./setup.sh             # generates a new key and prints it
sudo systemctl restart print_server
# Then paste the new key into Firestore /config/print_bridge.apiKey
```

## Architecture quick reference

```
Manager's iPad / phone
   │  HTTPS POST /print/label
   │  X-API-Key: <secret from Firestore>
   │
   ▼
https://<machine>.tail<random>.ts.net    ← Tailscale Funnel
   │  (Tailscale terminates HTTPS, forwards to localhost:8443)
   │
   ▼
Flask print_server.py on the Pi
   │  • verifies X-API-Key
   │  • renders payload → 1-bit PIL image at 696×N px
   │  • brother_ql.convert + send
   │
   │  TCP port 9100 raster
   ▼
Brother QL-820NWB @ 192.168.1.34
   │
   ▼
Physical label on 62mm continuous tape
```

## Key design decisions worth knowing

**Why Tailscale Funnel instead of a self-signed cert or Let's Encrypt direct?**
The web app runs on a public URL (app.ddmaustl.com). Browsers won't fetch HTTP from an HTTPS page (mixed content), and a self-signed cert would require approving it in every browser. Tailscale Funnel gives a real LE cert automatically, with no port forwarding or domain setup. Free for personal use up to 100 devices.

**Why a separate `print_bridge` system user?**
If the Flask app gets a bug that runs arbitrary code, the blast radius is limited to that user — it can't read your SSH keys, mess with the desktop session, or modify `/etc`. Standard defense-in-depth.

**Why hardcode the Brother IP?**
DHCP reservations on the router pin the IP. The Brother's IP changes ~never. Editing config.json takes 10 seconds if it does change. Auto-discovery (mDNS) was tried first in our session — the Brother doesn't advertise consistently enough on every WiFi.

**Why 300 DPI?**
Native to the QL-820 series. 600 DPI is supported but doubles render time and produces no visible improvement for the kind of text we print (kitchen labels, prep dates). HQ mode at 300 DPI is the sweet spot.

**Why convert to 1-bit at the end with Floyd-Steinberg dither?**
The Brother is monochrome — every pixel is black or white. PIL's `convert('1')` defaults to a hard threshold, which makes anti-aliased text look chunky. Floyd-Steinberg distributes the rounding error to neighboring pixels, which keeps small text legible.

## Updating the print server later

```
# On your Mac
cd dd-mau-portal/pi5-print-bridge
# Edit print_server.py
scp print_server.py ddmau@ddmau-pi5.local:~/

# Then on the Pi
sudo cp ~/print_server.py /opt/print_bridge/print_server.py
sudo systemctl restart print_server
sudo journalctl -u print_server -n 20  # check it came back up clean
```
