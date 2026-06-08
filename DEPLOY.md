# Deploy — push once, ship everywhere

```bash
cd ~/Developer/dd-mau-portal
npm run deploy
```

One command ships the **currently committed** code to:

| Target | How | Lands in |
|---|---|---|
| **Web** — app.ddmaustl.com | `git push` → GitHub Pages builds & deploys | ~1–2 min |
| **Pi menu TVs** | they load the web app | next TV refresh |
| **iOS app** | Capgo OTA bundle | next time the app is opened |
| **Android app** | Capgo OTA bundle | next time the app is opened |

> Commit your changes first, then `npm run deploy`. It bumps the version, builds, pushes web, and uploads the OTA bundle.

---

## The one boundary: JS rides OTA, native does not

- ✅ **JS / UI / features / fixes** (99% of work — chat, schedule, the TV picture editor, etc.) → ride OTA to the phones **automatically**. No Xcode, no Android Studio, no store review.
- ⚠️ **Native changes** — a *new* Capacitor plugin, a permission, the app icon/splash, a `capacitor.config` change → still need a rebuild (`npm run cap:ios` / `cap:android`) **and** a new store build. Rare.

So day-to-day it's truly one command. The App Store / Play Store only come up for the occasional native change.

---

## One-time setup (enables the phone-app OTA)

Until these two are done, `npm run deploy` still ships **web + TVs**, but **skips the phone apps** (it'll tell you).

### 1. Capgo API token
Put your Capgo key in the shell so the upload can authenticate:
```bash
echo 'export CAPGO_TOKEN=YOUR_CAPGO_KEY' >> ~/.zprofile
source ~/.zprofile
```
(Get/regenerate the key at **console.capgo.app → Account → API Keys**. Use an **"all"/upload-capable** key.)

### 2. A DEFAULT channel  ← this is what fixes the `no_channel` error
The apps self-assign to a *default* channel; right now none exists, so they can't find updates.
In **console.capgo.app**:
1. Open the app **com.ddmau.staff** → **Channels**.
2. Create a channel named **`production`** (or rename an existing one).
3. Toggle it **Default = ON**.
4. Toggle **"Allow devices to self-associate / self-set" = ON**.

That's it. From then on, `npm run deploy` pushes the `production` bundle and every iOS/Android device pulls it on next open.

> Want a different channel name? Set `export CAPGO_CHANNEL=<name>` and create/Default that one instead.

---

## What `npm run deploy` does (scripts/deploy.sh)
1. `npm version patch` — bump so the OTA bundle is newer than what's installed (Capgo only serves newer).
2. `npm run build`.
3. commit the version bump + `git push` → web.
4. `npx @capgo/cli bundle upload --channel production --bundle <version>` → iOS + Android (skipped if `CAPGO_TOKEN` is unset).
