# SMS Setup — Twilio integration

DD Mau staff portal sends one-way operational SMS via Twilio. SMS is
PARALLEL to FCM push: both fire from `notifications/{id}` creates, run
independently. SMS is reserved for urgent system notifications only —
chat-to-staff communication stays inside the app.

## Phase 1 surface (live as of 2026-05-19)

### Cloud Functions deployed
- `dispatchSms` — Firestore trigger; checks eligibility + sends Twilio SMS
- `twilioInbound` — HTTP webhook; handles STOP/START/HELP only
- `twilioStatusCallback` — HTTP webhook; updates `sms_delivery_logs` rows

### Collections
- `sms_delivery_logs/{id}` — one row per attempted SMS send
- `sms_inbound_events/{id}` — one row per inbound message received
- `sms_opt_in_events/{id}` — every opt-in / opt-out change (audit trail)
- `config/sms` — global settings doc (enabled, fromNumber, testMode)

### Staff record fields (`/config/staff.list[]`)
- `phoneE164` — sensitive; E.164 format (`+13145551234`)
- `smsOptIn`, `smsOptInAt`, `smsOptInBy`, `smsOptInSource`
- `smsStopped`, `smsStoppedAt` — set by inbound STOP reply only
- `smsLastSentAt`, `smsLastDeliveryStatus`, `smsLastFailureReason`

## Twilio one-time setup

### 1. Create a Twilio account
- Sign up at https://www.twilio.com/try-twilio
- Note the Account SID + Auth Token from the console dashboard
- Buy a phone number (Phone Numbers → Buy a Number; pick a local US
  number with SMS capability — DD Mau is in MO, a 314 area code is fine).
  Approx $1/mo per number.

### 2. Register the secrets with Firebase
```bash
firebase functions:secrets:set TWILIO_ACCOUNT_SID
# Paste the Account SID when prompted
firebase functions:secrets:set TWILIO_AUTH_TOKEN
# Paste the Auth Token when prompted
firebase functions:secrets:set TWILIO_FROM_NUMBER
# Paste the E.164 number (e.g. +13145555555)
```

Secrets are encrypted at rest by Google Secret Manager and injected
per-function at runtime. They never appear in source, deploy bundles,
or logs.

### 3. Deploy the functions
```bash
firebase deploy --only functions
```

Note the deployed URLs in the output. They will look like:
```
https://us-central1-dd-mau-staff-app.cloudfunctions.net/twilioInbound
https://us-central1-dd-mau-staff-app.cloudfunctions.net/twilioStatusCallback
```

### 4. Wire the Twilio number to those URLs

In the Twilio Console:

1. Phone Numbers → Manage → Active Numbers → click your number
2. Under **Messaging**:
   - "A message comes in" → Webhook → paste the twilioInbound URL → POST
   - "Status callback URL" → paste the twilioStatusCallback URL → POST
3. Save.

That's it. Inbound STOP / START / HELP replies will now hit our handler;
delivery status updates will flow into `sms_delivery_logs`.

### 5. Initial test
- Set `/config/sms` doc:
  ```js
  { enabled: true, testMode: true }
  ```
- Add your own staff record's `phoneE164` and `smsOptIn=true`
- Trigger a `shift_reminder_1h` notification (e.g. by writing a
  notification doc manually via the Firebase console)
- Confirm:
  - You receive the SMS
  - A `sms_delivery_logs` row appears with status `sent` → later `delivered`
  - A `sms_opt_in_events` row exists from when you flipped opt-in
- Reply STOP from your phone
- Confirm:
  - You get the auto-reply ("You are unsubscribed...")
  - Your staff record now has `smsStopped: true`
  - A `sms_inbound_events` row exists with `kind: 'stop'`
  - A `sms_opt_in_events` row with `source: 'sms_stop_reply'`, `action: 'opt_out'`

After successful test, flip `testMode: false` to allow real fan-out to
opted-in staff.

## Eligibility — what triggers an SMS

A notification doc → SMS only when **ALL** of:
1. `notif.type ∈ ALWAYS_SMS_TYPES` (see `functions/smsTemplates.js`)
2. `notif.skipSms !== true` (per-event opt-out flag)
3. Staff has `phoneE164` (valid E.164)
4. Staff has `smsOptIn === true`
5. Staff has `smsStopped !== true`
6. Global `/config/sms.enabled !== false`
7. If `/config/sms.testMode === true`, recipient must be an owner (id 40/41)
8. No existing `sms_delivery_logs` row for the same `notificationId` (dedup)

If any check fails, the function logs the reason and returns without
writing a log row (only ATTEMPTED sends get logged — keeps the table
clean).

## ALWAYS_SMS_TYPES (urgent only)

```
shift_reminder_1h    coverage_request    coverage_approved
coverage_denied      required_ack        urgent_announcement
eighty_six_alert     maintenance_urgent  weather_closure
schedule_change_today  pto_approved      pto_denied
swap_approved        swap_denied         task_handoff
```

Chat messages (`chat_message`, `chat_mention`, `chat_nudge`) and routine
admin records (`*_admin`, `catering_due_*`, `invoice_due_*`,
`onboarding_doc_submitted`, etc.) are deliberately push-only.

## Opt-in audit trail

`sms_opt_in_events` captures EVERY change with:
- staffName, staffId, phoneE164
- action: `opt_in` | `opt_out`
- source: `self_app` | `admin_panel` | `sms_stop_reply` | `sms_start_reply` | `onboarding_form` | `system`
- byName, byId
- consentTextVersion + consentTextEn + consentTextEs (verbatim snapshot of
  the disclosure shown at opt-in time)
- ipAddress, userAgent (when self-service)
- twilioMessageSid (when triggered by STOP/START reply)
- at (server timestamp)

Export from AdminPanel → "Export SMS opt-in log" (Phase 2). The CSV
includes one row per event; for compliance reviews, that file is
the complete history.

## Compliance posture (TCPA / CTIA)

- **Opt-in required:** dispatchSms refuses to send unless `smsOptIn === true`
- **STOP honored immediately:** inbound webhook sets `smsStopped=true` and
  Twilio auto-blocks the number/from pair at the carrier level
- **HELP responded:** auto-reply with contact info
- **Disclosure language stored:** every opt-in row has the exact text
  the user agreed to + version
- **No PII in body:** templates carry shift time, location, item name —
  no SSN, no payroll, no medical details
- **Every send logged:** `sms_delivery_logs` is the send history
- **Every change logged:** `sms_opt_in_events` is the consent history

## Cost expectations

Twilio US SMS pricing: ~$0.0079 per outbound SMS + $1/mo per phone number.

For DD Mau's team (30 staff × ~3 urgent SMS/day × 30d) ≈ **$22/mo**.

Add daily cap per staff in Phase 3 if cost ever spikes.

## Disabling everything in a hurry

If something goes sideways (template typo, mass-send bug, runaway cost):

1. **Soft disable (recommended):** set `/config/sms.enabled = false` —
   dispatchSms still runs but bails immediately. Inbound + status
   callbacks keep working so STOP replies still register. No code deploy.

2. **Hard disable:** delete the Twilio webhook URL in the Twilio Console.
   Inbound + status updates stop flowing. dispatchSms still tries to
   send (until you flip `enabled=false` too) but inbound auto-replies
   stop.

3. **Full kill:** `firebase functions:delete dispatchSms` removes the
   function entirely.

## Phase 2 (next)

- AdminPanel staff editor: phone field + opt-in toggle + status pill
- Bulk-tag panel: `smsOptIn` mass toggle
- Export SMS opt-in log → CSV
- Backfill helper: pull `hire.phone` → `staff.phoneE164` for existing records

## Phase 3 (later)

- New notification types: `urgent_announcement`, `weather_closure`,
  `maintenance_urgent`, `schedule_change_today` — composer + sender UI
- `invite_sent` SMS for new hires (text the onboarding portal link)
- Daily cap rate limiting (`config/sms.dailyCapPerStaff`)
- Quiet hours toggle for non-emergency types
- Self-service profile UI for staff to manage their own opt-in
