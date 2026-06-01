# NFC — future use plan

2026-05-31. Andrew flagged NFC as "might add in the future." Documenting
the setup here so when a real use case arrives the wiring is a known
10-minute job, not a research session.

## When to do this

Trigger conditions — pick one:
- **Clock-in via NFC tags** — staff tap a phone to a kitchen-station NFC sticker to start/end a shift.
- **Inventory scanning** — supply boxes with NFC tags get scanned during inventory counts to auto-fill item ID + qty.
- **Vendor pricing import** — Sysco / US Foods boxes occasionally carry NFC; could replace CSV upload for some items.
- **Customer-side loyalty** — staff scans a customer's phone NFC for points / repeat-order recognition.
- **Hardware key for admin operations** — Andrew taps his phone to authorize a destructive action without typing the PIN.

If none of these have materialized in 6 months, drop this file — we don't need NFC clutter.

## Install commands when ready

```bash
# Pick ONE of these (only one NFC plugin needed):
npm install @capawesome-team/capacitor-nfc        # Recommended — Capawesome team maintains it
# or
npm install @exxili/capacitor-nfc                  # Lighter, simpler API
# or
npm install @capacitor-community/nfc               # Community, less maintained as of 2026
```

Then:
```bash
npx cap sync
```

## iOS configuration (in `ios/App/App/Info.plist`)

Add:
```xml
<key>NFCReaderUsageDescription</key>
<string>DD Mau uses NFC to {SPECIFIC USE CASE GOES HERE}.</string>
```

Apple **will reject** vague copy. Be honest and specific — Apple App Store
review reads these. Example acceptable: "to scan kitchen-station tags
for staff clock-in." Example unacceptable: "for app features."

Add the entitlement file at `ios/App/App/App.entitlements`:
```xml
<key>com.apple.developer.nfc.readersession.formats</key>
<array>
    <string>TAG</string>
    <!-- or NDEF for NDEF-formatted tags only -->
</array>
```

In Xcode: Signing & Capabilities → + Capability → **Near Field Communication Tag Reading**.

In Apple Developer Portal: Identifiers → `com.ddmau.staff` → check **NFC Tag Reading** in the capabilities list. Apple won't let you build with NFC entitlement until this is on.

## Android configuration (in `android/app/src/main/AndroidManifest.xml`)

Add:
```xml
<uses-permission android:name="android.permission.NFC" />
<uses-feature android:name="android.hardware.nfc" android:required="false" />
```

`required="false"` means the app still installs on devices without NFC
hardware. Devices without NFC just don't see NFC features.

## Use it

```js
import { Nfc } from '@capawesome-team/capacitor-nfc';

// Check if device supports NFC
const { isSupported } = await Nfc.isSupported();
if (!isSupported) {
    toast('This device does not support NFC');
    return;
}

// Listen for a scan
const sub = await Nfc.addListener('nfcTagScanned', (event) => {
    console.log('Tag scanned:', event.nfcTag);
});

// Start a scan session (iOS shows a system sheet; Android starts foreground listener)
await Nfc.startScanSession();

// Stop later
await Nfc.stopScanSession();
sub.remove();
```

## What NOT to do until then

- Don't install the plugin "just to have it." Adds bytes + a dependency
  with no payoff. The package install in CAPACITOR_PREP.md Part 3 list
  intentionally omitted NFC for this reason.
- Don't add the NFC usage description to Info.plist preemptively.
  Apple will see it and question why we need NFC if we don't actually
  use it.
- Don't enable NFC in the Apple Developer portal for our App ID until
  we're ready — keeping the cap surface tight reduces review questions.

## Cross-reference

- Capacitor docs: https://capacitorjs.com/docs/plugins
- Apple Core NFC: https://developer.apple.com/documentation/corenfc
- Android NFC: https://developer.android.com/develop/connectivity/nfc
