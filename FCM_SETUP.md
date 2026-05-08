# DD Mau push notifications — setup guide

Code is shipped. To turn push notifications ON, do these steps in order. Each step says exactly what to click and what to copy.

**Time estimate:** 20–30 minutes total.
**Cost:** $0/month at DD Mau's volume (Cloud Functions free tier covers it). Requires Blaze plan billing setup but won't actually charge.

---

## Step 1 — Upgrade Firebase project to Blaze plan (5 min)

Cloud Functions require Blaze (pay-as-you-go) even though usage stays inside the free tier.

1. Open https://console.firebase.google.com/project/dd-mau-staff-app/usage/details
2. Click **"Modify plan"** at the bottom
3. Select **"Blaze · Pay as you go"**
4. Add a payment method (credit card)
5. Set a **budget alert** at $5/month so if anything goes wrong you get an email before being charged real money. Click "Set a budget" → enter `5` → Save.
6. Click **"Purchase"**

You're now on Blaze. Free-tier limits still apply — DD Mau's notification volume will not come close to triggering charges.

---

## Step 2 — Generate the VAPID Web Push key (3 min)

This key lets the browser verify push messages are coming from your project.

1. Open https://console.firebase.google.com/project/dd-mau-staff-app/settings/cloudmessaging
2. Scroll to **"Web Push certificates"** section near the bottom
3. Click **"Generate key pair"**
4. A long string starting with `B...` will appear. **Copy the entire key** (it's the public key)
5. In this repo, open `src/messaging.js`
6. Find the line:
   ```
   export const VAPID_KEY = "REPLACE_WITH_VAPID_PUBLIC_KEY";
   ```
7. Replace `REPLACE_WITH_VAPID_PUBLIC_KEY` with the key you copied (keep the quotes)
8. Save the file
9. Commit and push:
   ```
   cd /tmp/dd-mau-portal
   git add src/messaging.js
   git commit -m "Add VAPID public key for FCM"
   git push
   ```
10. GitHub Pages will rebuild in ~90s

---

## Step 3 — Install Firebase CLI (one time, 2 min)

If you've never used `firebase` from the command line before:

```
npm install -g firebase-tools
firebase login
```

The `login` step opens a browser — sign in with your Google account that owns the Firebase project.

---

## Step 4 — Deploy the Cloud Functions (5 min)

```
cd /tmp/dd-mau-portal/functions
npm install
cd ..
firebase deploy --only functions
```

You'll see something like:
```
✔ functions[dispatchNotification(us-central1)]: Successful create operation.
✔ functions[sendShiftReminders(us-central1)]: Successful create operation.
```

Both functions are live.

---

## Step 5 — Test it on your phone (5 min)

1. On your phone, open the deployed DD Mau app in **Safari (iPhone)** or **Chrome (Android)**
2. Add to Home Screen so it runs as a PWA (this is required on iPhone for push to work)
3. Open the app → Schedule tab → tap the 🔔 bell icon at top right → tap "Enable browser notifications"
4. Grant permission when iOS/Android asks
5. From a different account or computer, do something that fires a notification — e.g., approve a PTO request
6. Your phone should get a push notification within seconds, even if the DD Mau app is closed

If it doesn't work, check:
- iPhone: PWA must be installed to Home Screen (Safari → share → Add to Home Screen). Push doesn't work in plain Safari tab.
- Permission must be granted (Settings → Notifications → DD Mau → enable)
- VAPID key in `src/messaging.js` must match what's in the Firebase Console
- `firebase deploy --only functions` must have succeeded

---

## What's already wired (you don't need to do anything for these)

- Push fires automatically on these events: PTO approved/denied, swap approved/denied, week published, **1-hour-before-shift reminder** (server-side, scheduled every 5 min)
- Each device that grants permission stores its FCM token on the staff record
- Up to 5 devices per staff member (covers phone + tablet + work laptop)
- Tokens that go stale (uninstall, etc.) get auto-pruned by the Cloud Function

---

## Verify it's working (after Step 4)

Check Cloud Function logs:
```
firebase functions:log --only dispatchNotification --limit 20
firebase functions:log --only sendShiftReminders --limit 20
```

You should see entries like `Sent push for John Doe: 1 ok, 0 failed` after triggering a notification.

---

## Cost monitoring

Even though we expect $0, set up the alert anyway:

1. Visit https://console.cloud.google.com/billing/budgets?project=dd-mau-staff-app
2. The $5 budget you set up in Step 1 should be there
3. You'll get an email if usage approaches it — should never happen

---

## Tearing it down (if you ever want to)

To pause push notifications without deleting code:
```
firebase functions:delete dispatchNotification
firebase functions:delete sendShiftReminders
```

The app will continue working with foreground-only notifications.

To downgrade off Blaze: same Firebase Console URL as Step 1, click "Modify plan" → Spark.
