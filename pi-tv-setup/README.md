# Pi TV kiosk setup — exact files from the working Pi 5 (webster-photos)

Snapshot taken 2026-06-10 from `ddmau@ddmau-pi5.local` after everything was
verified working on a cold boot. Apply the same set to the two Pi 4 menu TVs
when they're installed (or restore a dead SD card).

## What each file does

| File on the Pi | Copy here | Why |
|---|---|---|
| `/usr/local/bin/dd-mau-kiosk.sh` | `dd-mau-kiosk.sh` | Kiosk launcher. Waits until app.ddmaustl.com is reachable before starting Chromium (after a power outage the Pi boots faster than the router — without this the TV lands on a "No internet" error page), then relaunches Chromium if it ever crashes. Also carries `--force-device-scale-factor=2` (4K TVs render as Retina 1080p — crisp text, correct layout). **Edit the `tv=` parameter in URL per TV.** |
| `~/.config/autostart/dd-mau-tv.desktop` | `dd-mau-tv.desktop` | Autostart entry — just points at the launcher script. |
| `/usr/local/bin/hdmi-full-range.sh` | `hdmi-full-range.sh` | Forces full-range RGB output. In "Automatic" the Pi sends limited-range (16–235) for TV modes; the 4K panel read it as full-range → washed-out colors. |
| `/etc/systemd/system/lightdm.service.d/hdmi-full-range.conf` | `hdmi-full-range.conf` | Runs the script right before lightdm takes the display. (A standalone systemd unit does NOT work — gets Permission denied because something still holds the display.) |
| `/boot/firmware/cmdline.txt` | `cmdline.txt.reference` | Reference only — the change is: remove `splash`, append `plymouth.enable=0`. The boot splash held the display and blocked the color fix. Don't copy this file verbatim (PARTUUID is per-SD-card); make the same two edits instead. |

Needs `libdrm-tests` for `modetest`: `sudo apt install -y libdrm-tests`

## Apply to a freshly imaged Pi (after the standard TV runbook)

```bash
# from the Mac, with SSH key + NOPASSWD sudo already set up on the Pi:
PI=ddmau@NEW-PI.local
scp dd-mau-kiosk.sh hdmi-full-range.sh $PI:/tmp/
ssh $PI '
  sudo apt-get install -y libdrm-tests &&
  sudo install -m755 /tmp/dd-mau-kiosk.sh /usr/local/bin/ &&
  sudo install -m755 /tmp/hdmi-full-range.sh /usr/local/bin/ &&
  sudo mkdir -p /etc/systemd/system/lightdm.service.d
'
scp hdmi-full-range.conf $PI:/tmp/
ssh $PI '
  sudo install -m644 /tmp/hdmi-full-range.conf /etc/systemd/system/lightdm.service.d/ &&
  sudo sed -i "s/ splash//; s/$/ plymouth.enable=0/" /boot/firmware/cmdline.txt &&
  sudo systemctl daemon-reload
'
# then: edit the tv= param in /usr/local/bin/dd-mau-kiosk.sh on the Pi,
# point ~/.config/autostart/dd-mau-tv.desktop Exec= at the script, reboot.
```

## Verify after reboot

```bash
ssh $PI 'sudo cat /sys/kernel/debug/dri/*/state | grep -E "is_limited_range|output_format"'
# want: is_limited_range=n, output_format=RGB
ssh $PI 'pgrep -af dd-mau-kiosk && ps -u ddmau -o args= | grep -c force-device-scale-factor'
```

## Revert the color fix (if a TV looks WORSE — crushed blacks)

That panel expects limited-range. Either:
```bash
ssh $PI 'sudo rm /etc/systemd/system/lightdm.service.d/hdmi-full-range.conf && sudo systemctl daemon-reload && sudo reboot'
```
…or leave the Pi alone and set the TV's own "HDMI Black Level" (Samsung) /
"Black Level" (LG) to match.

## Notes

- 1080p (non-4K) TVs: remove `--force-device-scale-factor=2` from the
  launcher — at 1080p it would render everything double-size.
- The color fix applies regardless of resolution (limited-vs-full mismatch
  exists at 1080p too).
- Remote management: `ssh ddmau@<pi>.local` works from the Mac on the same
  Wi-Fi (key + passwordless sudo installed). The in-app "⟳ Reload TV" button
  (Menu Screens) refreshes the page; SSH `sudo reboot` for a full restart.
