# Biometric Login Architecture — DD Mau → Multi‑Tenant SaaS

**Status:** Design only. No code. Planning doc to review before any implementation.
**Author:** senior mobile-security / iOS / Android / full-stack / auth-architect pass, 2026‑06‑29.
**Companion docs:** `SAAS-PLAN.md` (Part 2 = login/security), memory `project_saas_plan`.

---

## 0. The one thing that must be said first (read this before anything)

**The app has NO real authentication today.** Identity is a 4‑digit PIN checked *client‑side*, the "owner" is a hardcoded `id === 40 || 41`, and Firestore rules end in a catch‑all (`allow read/write: if true`). There is no per-user token, no server-enforced tenant boundary, and no session.

**Therefore biometrics CANNOT be bolted onto the current app.** Face ID unlocking a client-side PIN check adds *zero* real security — anyone past the unlock still has full catch-all database access. Biometrics is only meaningful **on top of a real auth + session + tenancy layer**. So the true sequence is:

1. Build real auth (Firebase Auth or the SaaS JWT in SAAS-PLAN.md) + server-enforced tenant/role on every request.
2. Build refresh-token sessions + a revocable session/device registry.
3. *Then* add biometrics as a **local unlock** over that session.

Biometrics is **Phase ~3** of the SaaS migration, not a standalone feature. The "first 15 tasks" at the bottom are sequenced so that **nothing touches the live PIN/login path** until the new path is proven in parallel behind a flag.

---

## 1. Mental model (the core rule)

```
Biometric  →  unlocks  →  a secret in Keychain/Keystore  →  a refresh token  →  a short-lived access token  →  every request re-checked server-side
```

- **Biometrics is a LOCAL gesture.** It proves "the same human who set this up is holding the phone." It is NOT an authentication factor the server ever sees or trusts.
- **The server never learns a biometric happened.** It only ever validates a token. A biometric unlock that yields a *revoked* token = access denied. This is what makes "lost device / removed tenant access" safe.
- **Authorization is 100% server-side, every request.** Tenant + location + role are claims *inside* the token, validated against the DB on the server. A biometric unlock can never "pick the wrong tenant" because it doesn't pick anything — it just decrypts the one token that was stored for that one user on that one device.

---

## 2. iOS Face ID architecture

- **Plugin:** a Capacitor biometric plugin (`@aparajita/capacitor-biometric-auth` or `capacitor-native-biometric`) — **native code → requires a new App Store build** (cannot ship via Capgo OTA). Pick ONE and wrap it behind our own `biometrics.js` facade so the rest of the app never imports it directly.
- **Storage:** iOS **Keychain**, item protected by a `SecAccessControl` created with:
  - `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` — never syncs to iCloud, never leaves the device, only readable while the device is unlocked.
  - `.biometryCurrentSet` (NOT `.biometryAny`) — **if the enrolled face/finger set changes (a new face is added), the stored secret is invalidated automatically.** This is the re-enrollment defense (§13).
  - Optionally `.or .devicePasscode` is **off** for the high-value secret so a passcode alone can't substitute for biometry (your call; passcode fallback is convenient but weaker).
- **What's stored:** NOT the refresh token in clear. Store a random 256-bit **wrapping key** (or store the refresh token itself as the Keychain item value) gated by the access control. On unlock, LocalAuthentication (`LAContext.evaluateAccessControl`) prompts Face ID; success returns the secret; we use it to get/decrypt the refresh token, then exchange it for an access token.
- **Never** call/read raw biometric data. We only ever get a boolean "the OS authenticated the enrolled user." Apple never exposes face data; do not attempt it.
- **Info.plist:** `NSFaceIDUsageDescription` ("Use Face ID to unlock your DD Mau session").

## 3. Android biometric architecture

- **Plugin:** same facade; under the hood **BiometricPrompt** (AndroidX) + **Android Keystore**.
- **Storage:** generate a Keystore AES key with:
  - `setUserAuthenticationRequired(true)` — the key can only be used after a successful BiometricPrompt.
  - `setInvalidatedByBiometricEnrollment(true)` — **new fingerprint/face enrolled → key destroyed** (re-enrollment defense, mirrors iOS `.biometryCurrentSet`).
  - `setUserAuthenticationParameters(0, BIOMETRIC_STRONG)` — require **Class 3 (STRONG)** biometrics only; reject weak/Class 2.
  - StrongBox (`setIsStrongBoxBacked(true)`) when the device has a hardware security module; fall back gracefully if not.
- **Envelope encryption:** encrypt the refresh token with that Keystore key (AES‑GCM). Store the ciphertext + IV in normal app storage; the *key* lives in hardware and only unlocks after BiometricPrompt. Decrypt-on-unlock → refresh token → access token.
- BiometricPrompt with `setAllowedAuthenticators(BIOMETRIC_STRONG)`. Do not allow `DEVICE_CREDENTIAL` for the high-value secret unless you explicitly want PIN/pattern fallback.

## 4. Web fallback behavior

- **No platform biometrics on web** in v1. The web app (`Capacitor.isNativePlatform() === false`) hides all biometric UI and always uses the normal secure login (email/password or magic link).
- The refresh token on web lives in an **httpOnly, Secure, SameSite=strict cookie** set by the backend — never in `localStorage` (XSS-exfiltratable). Access token in memory only.
- Future option (separate effort): **WebAuthn / passkeys** for web "biometric-like" login. Out of scope here.

## 5. Secure token storage (the matrix)

| Platform | Refresh token at rest | Unlock gate | Access token |
|---|---|---|---|
| iOS native | Keychain item, `WhenUnlockedThisDeviceOnly` + `.biometryCurrentSet` | Face ID via `evaluateAccessControl` | in memory only |
| Android native | AES‑GCM ciphertext; key in Keystore, `UserAuthenticationRequired` + `InvalidatedByBiometricEnrollment` + STRONG | BiometricPrompt | in memory only |
| Web | httpOnly Secure cookie (server-set) | normal login | in memory only |

**Rules:** access token TTL **5–15 min**; refresh token TTL **7–30 days**, **rotating** (each refresh issues a new refresh token + invalidates the old — detects token theft via reuse). Never persist access tokens. Never put any token in logs, analytics, Sentry, URLs, or query strings (extend `redact.js`).

## 6. Session refresh logic

- On cold start / resume: try the **in‑memory access token**. If expired → silently refresh using the stored refresh token (no biometric needed for a *background* refresh **within an unlocked session**) OR require biometric if the app was backgrounded past the lock timeout (§ app-resume).
- **Refresh endpoint** (`POST /auth/refresh`): validates the refresh token against the server **sessions** table → checks the session is not revoked, the user still exists, tenant access still granted, password not changed since issuance, role not downgraded → issues new access + rotated refresh, or `401` (forcing full login).
- **Rotation + reuse detection:** if a *already-used/rotated* refresh token is presented, treat as theft → revoke the whole session family + audit `suspicious_activity`.
- Clock-skew tolerant; offline grace: allow a short read-only offline window using the last valid access token (configurable), but any mutation requires a fresh server check.

## 7. Tenant isolation

- Every token carries `tenantId` (+ allowed `locationIds`, `role`) as **server-signed claims**. The client cannot forge or change them.
- **Every** backend handler resolves `tenantId` from the verified token, **never** from a request body/param, and scopes all reads/writes to it. Firestore rules (or the SaaS API) enforce `resource.tenantId == token.tenantId`.
- A biometric unlock yields a token for exactly **one (user, tenant)** pairing that was stored at enable-time. A user with access to multiple tenants gets a **per-tenant** stored session (or the token lists tenants and the app forces an explicit tenant pick after unlock; the chosen tenant is re-validated server-side on the next request).
- **Cross-tenant is impossible by construction:** there is no client path that swaps `tenantId` — it's inside the signed token, validated on the server.

## 8. Role / permission checks

- Roles: `super_admin` (you/platform) → `owner` → `admin` → `manager` → `employee`. Stored server-side per (user, tenant). Token carries the **current** role.
- Server enforces role on every privileged endpoint (defense in depth: also reflect in UI gating, but UI gating is cosmetic only).
- **Role change takes effect on next refresh** (≤ access-token TTL). For instant downgrade on sensitive removals, the refresh check reads live DB role → a removed manager loses manager endpoints within minutes even mid-session.

## 9. Shared device rules (the subtle, high-risk part)

A shared iPad/tablet has **multiple people's faces enrolled in the OS** → its Face ID cannot prove *which staff member* it is. So:

- **Do NOT** use the shared device's Face ID to identify a staff member or to unlock "employee mode as a person."
- **Device registration:** the device is enrolled once by an admin/manager → it gets a **device record** `{ deviceId, tenantId, locationId, status }` and a **device credential** (a long-lived, *revocable*, device-scoped token with NO user identity — only "this iPad belongs to Tenant X, Location Y"). Stored in Keychain/Keystore, optionally gated by a *device* biometric/passcode for the shared-device owner.
- **Staff clock-in:** a 4‑digit **PIN** (hashed, tenant+location-scoped, server-verified, rate-limited) identifies the employee for clock-in/out only. PIN ≠ login to anything sensitive. The device credential establishes tenant/location; the PIN establishes which employee within it.
- **Manager mode on a shared device:** requires a **real manager login** (email/pw or magic link) OR the manager typing their **manager PIN** (distinct, higher-entropy, server-verified, rate-limited) — NOT the iPad's Face ID. Manager mode opens a short, auto-expiring elevated session that drops back to staff mode on timeout/idle.
- The manager's **personal-phone** biometric is fine (it's their device, their face) — but it unlocks **their** session, never "staff mode" for everyone.

## 10. Personal device rules

- Owner/admin/manager/employee **personal phones**: after first secure login, may enable biometric unlock for **their own** account only.
- One user per personal device session. Multiple faces enrolled on a personal phone is the user's own risk; `.biometryCurrentSet`/`InvalidatedByBiometricEnrollment` means *adding* a face invalidates the stored secret → forces re-login (acceptable; rare).
- Employees get the **least** elevated session; their token grants employee-scoped endpoints only.

## 11. Staff PIN interaction

- The 4‑digit PIN **stays** for fast clock-in/out on shared devices, but is upgraded: **salted hash, server-side verify, per-tenant uniqueness, rate-limited (e.g., 5 tries / 15 min / device, then lockout), never stored or logged in clear** (today PINs are plaintext-ish in `staff` + `pin_audits` — see QA-audit memory). PIN identifies an employee for clock-in within an already-tenant-bound device; it is not a login to admin/manager surfaces.
- On personal devices, biometric unlock **replaces** PIN entry for that user (faster). PIN remains the fallback if biometrics fails/unavailable.

## 12. Logout behavior

- Logout = (1) delete the Keychain/Keystore secret + ciphertext, (2) call `POST /auth/logout` to **revoke the server session** (so the refresh token is dead even if a copy leaks), (3) clear in-memory access token + all cached tenant data, (4) audit `biometric_disabled` (if it was on) + session end.
- "Log out everywhere" (owner/admin self-serve): revokes all of that user's sessions across devices.

## 13. Lost / stolen device revocation

- Admin dashboard → **Devices** list (per tenant): each registered device + active session shows last-seen, platform, location. **Revoke** → server marks the session/device revoked → the very next `/auth/refresh` returns `401` → app wipes local secrets + forces login. Even with a valid Face ID, the attacker gets nothing because the token is dead server-side.
- Because access tokens are short-lived (5–15 min), the worst-case window after revoke is one TTL.
- Combine with OS-level Find My / remote wipe guidance for shared iPads.

## 14. Biometric re-enrollment behavior

- iOS `.biometryCurrentSet` + Android `setInvalidatedByBiometricEnrollment(true)` mean: **if someone adds/changes a fingerprint or face on the device, the stored secret is destroyed by the OS.** → app detects the secret is gone → forces a full secure login → user re-enables biometrics. This blocks the "attacker enrolls their own face to bypass the owner's Face ID" attack. Audit `biometric_disabled` (auto) then `biometric_enabled` on re-setup.

## 15. Audit logging (log every one of these)

`biometric_enabled`, `biometric_disabled`, `biometric_unlock_success`, `biometric_unlock_failure`, `fallback_login_used`, `device_registered`, `device_revoked`, `session_expired`, `tenant_access_denied`, `manager_mode_unlocked`, `staff_pin_used`, plus `suspicious_activity` (refresh-reuse), `password_changed`, `role_changed`, `tenant_access_revoked`.

Each row: `{ ts, tenantId, userId(or 'device'/'anon'), deviceId, platform, ip, event, outcome, reason, sessionId }`. **NEVER** log token values, PINs, or biometric data. Server-written (clients can't forge audit). Append-only; admin-readable per tenant; retention policy.

## 16. Error states (define UX + audit for each)

- Biometric not enrolled / not available on device → hide the option, use login.
- Biometric hardware locked out (too many OS fails) → fall back to secure login; audit `biometric_unlock_failure`.
- User cancels Face ID → return to login screen (no lockout of the app, just no shortcut).
- Stored secret missing/invalidated (re-enroll, OS update) → silent → full login.
- Refresh token expired/revoked → full login + clear local.
- Tenant access removed mid-session → `tenant_access_denied` screen, forced logout.
- Offline at unlock → allow read-only with last access token until TTL, then block.
- Clock-skew / server 5xx on refresh → retry w/ backoff, then login.

## 17. Testing checklist (must all pass before rollout)

1. Enable biometrics → kill app → cold start → Face ID/fingerprint unlocks → lands in correct tenant/location only.
2. Wrong/owner-absent: another enrolled face on a personal phone — verify your policy (currentSet invalidation forces re-login when a face is *added*).
3. Revoke session from admin → next action within one TTL → forced re-login despite valid biometric.
4. Remove user's tenant access server-side → biometric unlock → denied.
5. Downgrade role → privileged endpoints denied within one TTL.
6. Add a fingerprint/face on device → stored secret invalidated → forced login.
7. Refresh-token reuse (replay an old rotated token) → session family revoked + `suspicious_activity`.
8. Logout → token dead server-side (try the captured refresh token → 401).
9. Shared iPad: device credential + staff PIN clock-in works; manager mode requires manager login/PIN, NOT iPad Face ID; manager mode auto-expires.
10. PIN rate-limit lockout after N fails.
11. Offline cold start within TTL (read-only), past TTL (blocked).
12. Web: no biometric UI; httpOnly cookie session; logout clears it.
13. Backgrounded > lock timeout → require biometric again on resume; < timeout → no prompt.
14. No token ever appears in logs/Sentry/network logs (grep + Sentry scrub test).
15. Jailbreak/root: app still safe (server enforcement holds even if local storage is compromised — biometric is just a convenience).

## Security requirements (hard rules)

Do NOT store raw biometric data. Do NOT access face/fingerprint data. Use platform APIs only. Store tokens in Keychain/Keystore (never plaintext, never `localStorage`/`AsyncStorage` in clear). Never log tokens/PINs. Never expose secrets to the frontend (no service-account keys, API secrets, or signing keys in the app bundle — they're extractable). Rate-limit fallback login **and** PIN. Session expiration (short access, rotating refresh). Admin device/session revocation. **Require full login again after:** password change, role removal, tenant removal, biometric re-enrollment, refresh-reuse/suspicious activity.

## What to review in the current app (and the gaps found)

- **Login screen / PIN system:** PIN keypad, client-checked, plaintext PINs in `staff` + `pin_audits` (QA-audit memory AD1). → must move to salted-hash + server verify before any of this is meaningful.
- **Staff page / manager-admin access:** role via hardcoded ids + `role` string + `canX` client flags. → needs server-side role per (user, tenant).
- **Tenant security:** none yet (catch-all rules). → SAAS-PLAN.md Phase 1.
- **Mobile nav / app resume / background-foreground:** Capacitor `App` resume + the existing idle-relock (chat/keypad) are the hook points for "require biometric on resume after lock timeout." Reuse the idle/relock infra rather than inventing new.

## Deliverables (recap, all designed above)

Recommended user flow (§ below) · DB schema changes (§A) · API endpoint changes (§B) · iOS plan (§2) · Android plan (§3) · frontend state plan (§C) · security risks (§D) · what not to do (§E) · rollback plan (§F).

### Recommended user flow
First login = secure (email/pw, magic link, or verified invite) → server issues access+refresh, creates a session row, registers the device → app offers "Enable Face ID" → on enable, store the refresh-token secret gated by biometry + audit → next launches: biometric unlock → silent token exchange → in. Fail/cancel → secure login. Logout/revoke/role-loss → secrets wiped, full login required.

### §A Database schema changes (new collections/tables, tenant-scoped)
- `users` `{ id, email, tenants: [{tenantId, role, locationIds[]}], passwordUpdatedAt, status }`
- `sessions` `{ id, userId, tenantId, deviceId, refreshTokenHash, issuedAt, expiresAt, rotatedFrom, revokedAt, lastSeenAt, platform, ip }`
- `devices` `{ id, tenantId, locationId, kind:'personal'|'shared'|'clock', registeredBy, status, lastSeenAt }`
- `staff_pins` `{ tenantId, staffId, pinHash, salt, failCount, lockedUntil }` (replaces plaintext)
- `audit_auth` (append-only, the §15 events)
- Add `tenantId` to every existing business collection (migration).

### §B API endpoint changes (server-enforced; replaces catch-all)
`POST /auth/login`, `/auth/magic-link`, `/auth/refresh` (rotate), `/auth/logout`, `/auth/logout-all`, `POST /devices/register`, `POST /devices/:id/revoke`, `GET /devices` (admin), `POST /pin/verify` (rate-limited), `POST /auth/manager-elevate`. Every other endpoint: verify token → resolve tenant/role → scope. Biometrics has **no** server endpoint (it's purely local) except that enabling/disabling writes an audit row.

### §C Frontend state management plan
A single `authStore` (context/zustand): `{ status: 'locked'|'authed'|'loggedOut', user, tenantId, role, locationIds, accessToken(in-mem) }`. A `biometrics.js` facade (the only file importing the native plugin). A `secureSession.js` (refresh/rotate/revoke). Gate the whole app shell on `status==='authed'`; on resume-after-timeout flip to `'locked'` and show the biometric/login screen. Keep the existing PIN keypad as the shared-device + fallback path.

### §D Security risks
Native plugin = store-build dependency (no OTA fixes for the biometric layer). Plaintext-PIN migration must not lock staff out. A bug that trusts client-supplied `tenantId` = cross-tenant breach (mitigate: token-only tenant). Refresh token theft (mitigate: rotation + reuse detection + httpOnly on web). Shared-device identity confusion (mitigate: §9). Biometric false sense of security if server enforcement lags (mitigate: §0 ordering).

### §E What NOT to do
Don't ship biometrics before real auth + tenancy. Don't let Face ID gate a client-side check. Don't store tokens/PINs in plaintext or `localStorage`. Don't trust `tenantId` from the client. Don't use a shared iPad's Face ID to identify staff. Don't log tokens. Don't put any secret/signing key in the app bundle. Don't use `.biometryAny`/weak biometrics. Don't make biometrics the *only* way in (always keep secure-login fallback).

### §F Rollback plan
Everything new ships behind a `authV2Enabled` flag (per-tenant), defaulting OFF → the current PIN/login path is untouched and remains the live default. Roll out to one pilot tenant/device. If anything breaks: flip the flag off → instantly back to the current system (no data migration to undo for the auth path; the new `sessions`/`devices` rows are additive and ignored). The biometric native plugin is additive (new store build) but inert until the flag is on; if the plugin misbehaves, the flag-off path never calls it.

---

## Closing recommendation

**I recommend implementing biometrics as a secure unlock for an already-authenticated device session, not as the primary login, because** biometrics is a *local* possession-and-presence gesture that the server can never see or trust — it proves only "the enrolled human is holding this phone," not *who* they are to the backend. Real identity, tenant scoping, and roles must live in server-validated tokens checked on every request; if biometrics were the primary login, a stolen/jailbroken device, a re-enrolled face, or a removed-tenant user could bypass the only gate. As an *unlock* over a revocable, short-lived, server-enforced session, Face ID makes login faster **and** safer: it removes the password from the daily path, the secret never leaves the Secure Enclave / Keystore, and the moment a session is revoked or access is removed the unlock yields a dead token — so convenience and security move in the same direction instead of trading off.

---

## First 15 safest engineering tasks (do NOT break current login)

> All additive, flag-gated (`authV2Enabled`, default OFF), run in PARALLEL with the live PIN system. Nothing below changes the current login until task 15's pilot.

1. **Add a real auth backend** (Firebase Auth or SaaS JWT issuer) — *no client wiring yet*. Stand up `/auth/login`, `/auth/refresh` (rotating), `/auth/logout` as Cloud Functions; issue access(10m)+refresh(14d) with `{userId, tenantId, role, locationIds}` claims.
2. **Create the `sessions`, `devices`, `users`, `audit_auth` collections** + tenant-scoped Firestore rules for them (additive; existing collections untouched).
3. **Stand up `tenantId` on data, migration-only:** backfill a single default tenant on existing docs behind a script; no behavior change.
4. **Build the `audit_auth` writer** (server-side) for all §15 events; wire it to the new endpoints first.
5. **Migrate PINs to salted hash + server verify** (`/pin/verify`, rate-limited) writing to `staff_pins`; keep the old client check live in parallel; dual-read until verified.
6. **Build `biometrics.js` facade + `secureSession.js`** (pure JS, no UI) with a mock backend so it's unit-testable without the native plugin.
7. **Add the chosen biometric Capacitor plugin** + Keychain/Keystore access-control config (`.biometryCurrentSet` / `InvalidatedByBiometricEnrollment` + STRONG); ship a **new store build** that contains the plugin **inert** (flag OFF).
8. **Implement secure token storage** (iOS Keychain item / Android Keystore-wrapped ciphertext) behind the facade; unit + on-device test storing/retrieving a dummy secret.
9. **Implement enable/disable biometric** flow (writes the secret + `biometric_enabled` audit) on a hidden dev-only screen.
10. **Implement biometric unlock → token exchange** against the new `/auth/refresh`; `biometric_unlock_success|failure` audit; fallback-to-login on any failure.
11. **Build the admin Devices/Sessions dashboard** (list + revoke); prove revoke → next refresh 401 on a test device.
12. **Implement resume/background lock:** reuse the existing idle-relock infra → after lock timeout, flip `authStore.status='locked'` and require biometric/login on resume.
13. **Implement shared-device path:** device registration + device credential + manager-elevate endpoint; manager mode requires manager login/PIN, auto-expires; staff PIN clock-in unchanged in behavior, now server-verified.
14. **Run the §17 testing checklist** end-to-end on a real iOS + real Android device against a **staging tenant** (never the live store data).
15. **Pilot:** flip `authV2Enabled` ON for ONE test tenant / one personal phone + one shared iPad; run a week; keep the OFF path as instant rollback; then expand.
