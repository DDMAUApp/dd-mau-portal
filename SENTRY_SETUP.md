# Sentry Setup Runbook

DD Mau uses Sentry as its frontend + Cloud Function error monitoring "watcher."
The code is fully wired but no-op until you complete the steps below.

When live, Sentry will:
- Auto-capture every JS error, unhandled rejection, and React crash on every staff phone/iPad
- Auto-capture every Cloud Function exception (pollGmail, dispatchSms, etc.)
- Group identical errors so 200 crashes from one bug appear as 1 issue
- Push a mobile notification to your phone within ~15 seconds of a new error
- Show clean stack traces with line/file via source maps
- Auto-tag every event with staff name + role + location + app version

---

## Step 1 — Create the Sentry project (5 min)

1. Go to **https://sentry.io/signup/**
2. Sign up with `DDmauSTL@gmail.com` (or your preferred email).
3. When asked "What are you building?" → pick **React**. Sentry will scaffold a project.
4. Project name: `dd-mau-portal`.
5. On the next screen, Sentry shows you a DSN:
   ```
   https://<hash>@o<org_id>.ingest.sentry.io/<project_id>
   ```
   **Copy this.** It is NOT a secret (Sentry treats DSNs as public identifiers — abuse is throttled by per-project rate limits, not key secrecy) so it's safe to commit / log. But save it where you can find it.

6. Note your **org slug** (visible in the URL: `sentry.io/organizations/<ORG_SLUG>/projects/`). Common pattern: your sign-up email's first word. You'll need this for the source-map upload step.

---

## Step 2 — Create an auth token for source-map upload (2 min)

1. In Sentry, click your avatar → **User Settings**.
2. Left sidebar → **Auth Tokens**.
3. Click **Create New Token**:
   - **Name:** `dd-mau-source-maps`
   - **Scopes:** tick `project:write` and `project:releases`.
   - Click **Create**.
4. Copy the token (starts with `sntrys_…`). **This IS a secret.** Treat like an API key. Sentry will only show it once.

---

## Step 3 — Configure the frontend (3 min)

The frontend reads the DSN from `import.meta.env.VITE_SENTRY_DSN` at build time.
Set it via an `.env.local` file in the repo root (gitignored):

```bash
cd "/Users/andrewshih/Documents/Claude/Projects/DD Mau Training/dd-mau-portal"
cat > .env.local <<'EOF'
# Sentry — public DSN, OK to commit if you ever want to, but
# .env.local is gitignored by default.
VITE_SENTRY_DSN=https://YOUR_DSN_HERE

# Source-map upload (build time only). These three together
# enable the @sentry/vite-plugin and generate + upload .map files.
# Without them, sourcemap generation is disabled entirely.
SENTRY_AUTH_TOKEN=sntrys_YOUR_TOKEN_HERE
SENTRY_ORG=your-org-slug
SENTRY_PROJECT=dd-mau-portal
EOF
```

Test locally:

```bash
npm run build
```

You should see in the build output:
```
[sentry-vite-plugin] Successfully uploaded source maps to Sentry
```

If you DON'T see that line, the plugin isn't running — recheck env var spelling.

---

## Step 4 — Configure the backend (Cloud Functions) (1 min)

The backend uses Firebase secrets (the same mechanism as `ANTHROPIC_API_KEY` and the Twilio creds).

```bash
firebase functions:secrets:set SENTRY_DSN
# Paste the same DSN from Step 1 when prompted.
```

Then redeploy the functions that have `SENTRY_DSN` in their `secrets:` array (every critical handler — `pollGmail`, `dispatchSms`, `dispatchNotification`, `onCriticalError`, `pruneSystemLogs`, the AI functions):

```bash
firebase deploy --only functions
```

The deploy log will mention `ensuring 294644627803-compute@developer.gserviceaccount.com access to secret SENTRY_DSN.` — that confirms each function picked up the secret.

---

## Step 5 — Configure GitHub Actions (if you have CI) (optional)

Your existing GitHub Actions workflow deploys to GitHub Pages on every push to `main`. Without environment variables, the Actions build runs WITHOUT source-map upload — that's OK (frontend still captures errors, you just won't get pretty stacks in Sentry).

To enable source-map upload from CI:

1. Repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `SENTRY_AUTH_TOKEN` = the auth token from Step 2
   - `SENTRY_ORG` = your org slug
   - `SENTRY_PROJECT` = `dd-mau-portal`
   - `VITE_SENTRY_DSN` = the DSN from Step 1
2. Update the workflow YAML to pass them into the build step:
   ```yaml
   env:
     SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
     SENTRY_ORG: ${{ secrets.SENTRY_ORG }}
     SENTRY_PROJECT: ${{ secrets.SENTRY_PROJECT }}
     VITE_SENTRY_DSN: ${{ secrets.VITE_SENTRY_DSN }}
   ```

If you don't do this step: errors still get reported, you just see minified stack traces in Sentry until your local laptop build is what produces the deployed bundle.

---

## Step 6 — Smoke-test (5 min)

1. **Frontend test** — open the app, sign in, then in DevTools console:
   ```js
   throw new Error("Sentry FE smoke test")
   ```
   Within ~15 seconds, you should:
   - Get a phone push from the Sentry mobile app (download it from the App Store and sign in)
   - See the issue at `https://sentry.io/organizations/YOUR_ORG/projects/dd-mau-portal/`
   - See user.username = your staff name, location = your store, app_version = the build hash

2. **Backend test** — force-run pollGmail in Cloud Scheduler, or wait for the next scheduled tick. Any Anthropic 429 will become a Sentry issue tagged `fn:pollGmail`.

3. **Verify scrubbing** — file a bug via the 🪲 button with an email address or fake API key in the description, then look at the corresponding event in Sentry. The values should appear as `j***@gmail.com` / `<redacted-secret>`. If they appear in raw form, the redactor in `src/data/redact.js` needs tightening.

---

## Privacy posture

Sentry receives:
- Stack traces (with source code via uploaded maps)
- Browser metadata (UA, viewport, language, online status)
- Breadcrumbs (route changes, clicks, captured manually)
- Tags (staff name, role, location, app version, feature)

Sentry does NOT receive:
- Firestore document contents
- Gmail message bodies (the email triage classifier sends those to Anthropic, NOT Sentry)
- API keys, FCM tokens, passwords (scrubbed by `src/data/redact.js` via the `beforeSend` hook)
- IP addresses (`sendDefaultPii: false`)
- Email addresses (stripped from `event.user`)

Comparison: the email-classification path already sends full email subjects/bodies to Anthropic. Sentry's footprint is smaller.

---

## Cost reality

| Tier | What you get | $/mo |
|---|---|---|
| Developer | 5,000 errors / 10,000 perf events / 1 user | 0 |
| Team | 50,000 errors / 50,000 perf events / 3 users | 26 |

DD Mau's expected volume: 50–500 errors/month. Free tier covers you 10×. You will not need to upgrade unless something is very wrong.

---

## What's NOT yet wired

The Sentry SDK is initialized but per-function instrumentation is light: only the new `onCriticalError` and `pruneSystemLogs` functions have explicit `captureWithContext()` calls in their catch blocks. To cover the others (pollGmail, dispatchSms, etc.):

1. Add `secrets: [..., SENTRY_DSN]` to the function's options block (already done for the critical ones).
2. Add `captureWithContext(err, { fn: "<name>" })` next to any `logger.warn` / `logger.error` call.
3. The global `unhandledRejection` handler in `functions/sentry.js` catches anything that escapes a handler entirely.

This is opt-in by design — full-bore instrumentation can be added function-by-function as bugs surface.

---

## Disabling Sentry

To turn it off without uninstalling:

- **Frontend:** delete `VITE_SENTRY_DSN` from `.env.local` and rebuild. The SDK no-ops.
- **Backend:** remove SENTRY_DSN from the function's `secrets:` array and redeploy. Or `firebase functions:secrets:destroy SENTRY_DSN` to nuke it everywhere.

Removing the Sentry packages entirely:

```bash
npm uninstall @sentry/react @sentry/vite-plugin
cd functions && npm uninstall @sentry/node
```

Then delete `src/data/sentryClient.js`, `functions/sentry.js`, and the `sentry*` references in `main.jsx`, `logger.js`, and `vite.config.js`.
