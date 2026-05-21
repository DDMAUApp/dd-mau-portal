# Toast → 86 Sync Setup

This is the one-time setup for the Toast POS → DD Mau 86 Dashboard
auto-sync. When staff marks an item out-of-stock in Toast, our 86
dashboard auto-strikes it within ~5 minutes — no double entry.

## What you need from Toast

For **each location** (Webster + Maryland Heights), you need three
things from Toast:

1. **Toast Connect API access** (free, but you have to request it)
2. **Client ID** (OAuth credential)
3. **Client Secret** (OAuth credential)
4. **Restaurant External ID** (the location's GUID)

### How to get them

1. Log in to Toast Web → **Admin → Integrations → Toast Connect**
2. Request **API access** if you don't have it yet
3. Once approved, **create a Standard Integration** scoped to:
   - `stock:read` (required — read 86 status)
   - `menus:read` (required — look up item names from GUIDs)
4. Toast issues a `clientId` + `clientSecret`. Save them somewhere
   safe — you'll paste them into Firebase secrets below.
5. **Restaurant External ID**: Toast Web → **Restaurants → Integrations
   → External IDs**. Each location has its own GUID. Copy each.

## Configure Firebase secrets

From the repo root, in a terminal:

```bash
firebase functions:secrets:set TOAST_WEBSTER_CLIENT_ID
# (paste the Webster client_id when prompted)

firebase functions:secrets:set TOAST_WEBSTER_CLIENT_SECRET
# (paste the Webster client_secret when prompted)

firebase functions:secrets:set TOAST_MARYLAND_CLIENT_ID
firebase functions:secrets:set TOAST_MARYLAND_CLIENT_SECRET
```

After all 4 are set, redeploy the sync function:

```bash
firebase deploy --only functions:syncToastMenuStatus
```

## Configure restaurant GUIDs + enable per location

1. Open the app → **Admin** → scroll to **🍞 Toast POS → 86 sync**
2. For each location:
   - Paste the **Restaurant External ID (Toast GUID)**
   - Toggle **Enable Toast sync** on
   - Click **Save**
3. Wait up to 5 minutes for the first sync to fire
4. The status badge will turn green: **✓ Last sync: just now · N from Toast**

## Verify it's working

1. In Toast, mark an item out-of-stock (e.g. "Pork Bowl")
2. Wait 5 min (one cron tick)
3. Open the DD Mau app → **86 Dashboard**
4. "Pork Bowl" should be on the list, attributed to **Toast POS**
5. Open `https://app.ddmaustl.com/?tv=webster` — if you've mapped that
   item in hit zones, the red SOLD OUT stamp should now show on the
   menu image

Bring the item back in stock in Toast → wait 5 min → entry is removed
from the 86 dashboard automatically.

## How merging works

- **Toast-sourced 86s** carry `source: 'toast'`. The sync function adds/
  removes these to match Toast's current state.
- **Manual 86s** (set by staff in the 86 dashboard) carry no source
  field, or `source: 'manual'`. These are NEVER overwritten by the
  Toast sync.
- If both Toast and a staff member 86 the same item, the manual entry
  wins (it's never downgraded).

## Troubleshooting

**Status badge stays gray "Waiting for first sync":**
- The cron runs every 5 min. Wait up to 6 min after enabling.
- Check Firebase Logs → `syncToastMenuStatus` to see what happened.

**Status badge red "Last sync failed":**
- Most common: empty or wrong client_id / client_secret. Re-run the
  `firebase functions:secrets:set` commands and redeploy.
- "Toast auth 401": credentials are invalid — generate fresh ones in
  Toast Web.
- "Toast stock 403": your Toast Connect integration is missing the
  `stock:read` scope. Add it in Toast Web.
- "Toast menus 403": missing `menus:read` scope. Add it.
- "missing restaurantGuid": you haven't pasted the GUID in admin yet.

**Items appear with weird names (GUIDs instead of names):**
- The menu structure cache hasn't populated yet. Wait 5 min for the
  second sync — the function caches name lookups for 1 hour after
  the first successful fetch.

**Manual 86 doesn't auto-clear when Toast item comes back:**
- Expected — manual 86s are never auto-cleared. Staff has to clear
  manual entries manually in the 86 dashboard.

## Cost

- Toast API: free
- Firebase Cloud Function runs every 5 min = 288/day per location = 576/day total.
  Well under free tier (2M/month).
- No measurable additional cost.

## Disabling sync

Toggle off in admin. The function will stop pulling Toast data on the
next cron tick. Existing Toast-sourced 86 entries remain on the
dashboard until either:
- Staff manually clears them, OR
- You re-enable sync and Toast reports them back in stock
