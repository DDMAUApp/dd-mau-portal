# Migrating to `useFirestoreList` / `useFirestoreDoc`

Andrew 2026-05-27 — replaces the 119 silent-failure `onSnapshot(q, fn, console.warn)` patterns scattered through the app with a shared hook that gives every subscription proper loading/error/retry state.

## Why

Audit found:
- **119 `onSnapshot` calls** across the codebase
- Most error handlers were `(err) => console.warn(...)` — silent failures, no UI signal, no retry
- Every component reinvented its own loading state (or didn't bother)
- A transient permission-denied or network event left the listener dead with no recovery

The chat-loading bug was the felt pain — the hook is what prevents the next one.

## The hook in one line

```js
const { data, loading, error, retry } = useFirestoreList(queryFactory, deps, opts);
```

## Before → After

### Before (the pattern you're replacing)
```jsx
const [items, setItems] = useState([]);
useEffect(() => {
    if (!staffName) return;
    const q = query(collection(db, 'foo'), where('owner', '==', staffName), limit(50));
    const unsub = onSnapshot(q, (snap) => {
        const list = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() }));
        setItems(list);
    }, (err) => console.warn('foo snapshot failed:', err));   // ← silent
    return () => unsub();
}, [staffName]);
```

### After
```jsx
import { useFirestoreList } from '../data/useFirestoreList';
import { collection, query, where, limit } from 'firebase/firestore';
import { db } from '../firebase';

const { data: items, loading, error, retry } = useFirestoreList(
    () => staffName
        ? query(collection(db, 'foo'), where('owner', '==', staffName), limit(50))
        : null,
    [staffName],
    { label: 'foo-items', feature: 'foo' },
);
```

Then render:
```jsx
{loading && <Spinner />}
{error && <ErrorBanner code={error} onRetry={retry} />}
{!loading && !error && items.length === 0 && <EmptyState />}
{items.map(i => <Row key={i.id} item={i} />)}
```

## Key rules

1. **Factory, not value.** Pass `() => query(...)` not `query(...)`. Firestore queries don't have stable identity; passing the value directly would re-subscribe on every render.

2. **Return `null` from the factory when deps aren't ready.** The hook treats null as "skip subscription, stay in loading state." Use this instead of `if (!staffName) return` patterns.

3. **`deps` array follows React's rules.** If your factory closes over `staffName`, include it.

4. **Labels matter.** The `label` opt is used in `/error_logs` rows + Sentry tags. Set it to something queryable like `chats`, `86-items`, `inventory-webster`.

5. **Use `transform` for sorting/filtering** that should happen before render but isn't worth a useMemo:
   ```js
   useFirestoreList(factory, deps, {
       transform: (list) => list.sort((a, b) => b.createdAt - a.createdAt),
   });
   ```

## When NOT to use it

- **One-shot reads** (`getDoc`, `getDocs`) — the hook is for subscriptions only. Use Firestore's promise APIs directly for one-shots.
- **Writes** (`addDoc`, `updateDoc`, `setDoc`) — the hook doesn't help; use the Firestore SDK directly.
- **Compound state machines** where loading/error is one of many concerns (e.g. chat composer state) — the hook would clutter the render. Inline subscription is fine.

## Migration priority

Highest-value migrations first (most painful failures historically):

| Component | Subscriptions | Priority |
|---|---|---|
| `ChatCenter.jsx` chat-list | 1 | ✅ DONE (manual fix — keep for now) |
| `ChatThread.jsx` messages | 1 | ✅ DONE (manual fix — keep for now) |
| `Eighty6Dashboard.jsx` | 4 | 🔥 next (recent bugs) |
| `Schedule.jsx` | 16 | 🔥 high (most subs in one file) |
| `Operations.jsx` | ~10 | 🟠 medium |
| `InboxTriage.jsx` | 3 | 🟠 medium |
| `MyTasksPanel.jsx` | 2 | 🟡 low |
| `AdminHealthPage.jsx` | ~8 | 🟡 low (admin-only, low traffic) |
| Others | ~75 | as you touch them |

## What you get for free after migrating

- **Loading state** — built-in `loading` boolean, no more "blank screen for 2s"
- **Error visibility** — failures land in `/error_logs` AND Sentry AND the Error Report tab
- **Retry capability** — `retry()` callback for the user-facing button
- **Timeout safety** — 6s default before surfacing a "network slow" error
- **No setState-after-unmount warnings** — mounted-ref guard built in
- **Consistent label/feature tags** — search Sentry for `feature:86` across files
- **Less code per subscription** — typical migration drops ~30 lines

## Migration risks

- **Loading state UI:** existing components may show empty-state copy unconditionally. After migration, you need to gate the empty state on `!loading && !error`. The chat migration is the reference pattern (`ChatCenter.jsx` lines 456-498).
- **Existing custom error handling:** some onSnapshot error handlers do MORE than console.warn (e.g. fallback to cached data, set a flag). Check before migrating; the hook's error state may need to be paired with custom logic.
- **Subscriptions in transactions / inside callbacks:** the hook only works at component top level. Don't try to use it inside a click handler.
