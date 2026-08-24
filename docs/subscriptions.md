# Live Subscriptions

Live subscriptions let a client watch a data environment for changes in real time over
Server-Sent Events (SSE). OKDB uses a **signal-SSE + durable-session** model: the SSE
stream carries only lightweight **signals** — never document data — and the client
refetches the truth it needs from the normal query API.

## The two-domain rule at the client edge

OKDB internally separates the lossy **signal** plane (the UDP bus) from the durable
**data** plane (LMDB). Subscriptions apply the same split to the client connection:

- **SSE carries signals only** — `{ type, key, op, clock }`. No `value`, no `prevValue`.
- **Data comes from the query API** — on a signal, the client refetches the affected
  key(s)/queries (`get`/`query`, which already solve filter/sort/limit/pagination) and
  reconciles its local view.
- **The subscription is a durable, shared resource** — it lives in a dedicated `~sub`
  environment (`sync:false`), reachable by every process on the same LMDB path. The
  connection-owning worker is not a single point of truth.
- **The client owns its view** (the matched set). The server never stores or maintains it.

This makes subscriptions correct under clustering and multiple processes by construction
(shared LMDB + path-local POKE), with no cross-worker IPC routing.

## Endpoints

All routes are under `/api/<dataEnv>/subscriptions`, where `<dataEnv>` is the real data
environment whose changes you want to watch.

| Method   | Path                                   | Purpose                                           |
| -------- | -------------------------------------- | ------------------------------------------------- |
| `GET`    | `/subscriptions?type=…&filter=…&sub=…` | Open the signal SSE stream; mint/accept a session |
| `POST`   | `/subscriptions/:id/interests`         | Add/remove key interests (`{ add?, remove? }`)    |
| `PUT`    | `/subscriptions/:id/interests`         | Replace the full interest set (`{ interests }`)   |
| `POST`   | `/subscriptions/:id/filter`            | Set the enter-discovery filter (`{ filter }`)     |
| `DELETE` | `/subscriptions/:id`                   | Close the session (interests cascade)             |

`:id` is the `sessionId` issued in the first SSE frame.

## The signal stream

`GET /api/<dataEnv>/subscriptions` opens an SSE stream:

1. **Open frame** — the server mints a `sessionId` (or accepts `?sub=<id>` to reuse one),
   persists a durable `~sub` `session` record, and sends the id as the first frame:

    ```
    event: subscription:open
    data: { "sessionId": "…", "env": "default", "type": "Order", "filter": null, "reconnect": false }
    ```

2. **Signals** — every change matching the session's interests/filter arrives as:

    ```
    id: <clock>
    event: signal
    data: { "type": "Order", "key": "o-42", "op": "put", "clock": 1234 }
    ```

    Signals never carry document data. The client refetches `Order/o-42` and updates its
    view. `op` is `put` or `remove`; `clock` is the per-`(env,type)` changelog clock.

3. **Heartbeat / liveness** — a periodic beat (default 30s) refreshes the session's TTL
   (default 90s, skip-if-far so most beats are free) and re-checks `session.version` to
   pick up control changes. A `: ping` SSE keepalive rides the same beat.

4. **Disconnect** — a clean disconnect deletes the `session` (its `interest` rows cascade
   via FK `onDelete`). An unclean drop is reaped by TTL. Nothing leaks.

## Interests: keys vs. filter

A session expresses what it tracks two ways (combine as needed):

- **Explicit key interests** — for the keys the client currently shows. Register on enter,
  deregister on leave. Best for small/specific sets; there is a configurable cap on the
  number of explicit keys — push large/dynamic sets to a filter instead.
- **A declarative filter** — a `sift` query on the type. The router does **forward-only**
  enter-discovery: when a change to the type matches the filter and the session isn't
  already tracking that key, it signals an **enter candidate**.

Filters are declarative objects only (never functions — injection-safe), the same matcher
items/views/FTS use.

## Control plane (no IPC)

Control is plain REST keyed by `sessionId`. Each control call is a **durable write to the
`~sub` env plus a monotonic `version++`, committed atomically in one transaction**. The
write emits a path-local `SYSTEM_POKE`, which the owning connection catches as a latency
fast path; its heartbeat `version`-check is the correctness backstop, so a dropped POKE
self-heals within one beat (bounded staleness). Any path-local node can serve a control
write — the durable record is the single source of truth, so **no cross-worker IPC** is
needed.

```
POST /api/<dataEnv>/subscriptions/<id>/interests   { "add": [{ "type": "Order", "key": "o-42" }] }
PUT  /api/<dataEnv>/subscriptions/<id>/interests   { "interests": [{ "type": "Order", "key": "o-42" }] }
POST /api/<dataEnv>/subscriptions/<id>/filter      { "filter": { "status": "open" } }
DELETE /api/<dataEnv>/subscriptions/<id>
```

Unknown `sessionId` → `404`.

## Reconnect = resync

When a client reconnects with a still-live `?sub=<id>`, the server re-attaches to the same
durable session and emits one control frame:

```
event: subscription:resync
data: { "sessionId": "…", "version": 7 }
```

On `resync` the client re-runs its queries against current truth and **PUT-replaces** its
full interest set (`PUT …/interests`). Replace, not append: this drops any stale
pre-disconnect interests so they can't mis-route (the server also backstop-clears the
interest set on reconnect to make additive clients safe). There is no persisted cursor
anywhere — reconnect is always a resync to current state.

A brand-new or TTL-expired `sessionId` is a normal fresh open (no `resync`). Cross-machine
continuity is intentionally not provided — a client that reconnects to a different machine
re-registers and resyncs.

## Convergence, not per-transition

The data change-feed is **coalesced current-state** for cross-process writes, so
intermediate enter/leave transitions can be skipped. v2 guarantees **convergence to current
state**, not a per-transition event log: the client only ever learns "something changed,
here is the key," refetches, and reconciles. Design your client to be idempotent under
coalesced signals.

## Reference client

```js
// Minimal browser client. Holds a sessionId, refetches on each signal, and
// PUT-replaces its interest set on (re)connect / resync.
function subscribe(dataEnv, { type, filter } = {}) {
    const view = new Map(); // key -> doc (the client owns its matched set)
    let sessionId = sessionStorage.getItem('subId') || crypto.randomUUID();
    sessionStorage.setItem('subId', sessionId);

    const qs = new URLSearchParams({ sub: sessionId });
    if (type) qs.set('type', type);
    if (filter) qs.set('filter', JSON.stringify(filter));
    const es = new EventSource(`/api/${dataEnv}/subscriptions?${qs}`);

    // Re-declare the full interest set (PUT-replace, not append — race-safe on reconnect).
    async function resync() {
        const docs = await fetch(`/api/${dataEnv}/types/${type}/query`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filter: filter || {} }),
        }).then((r) => r.json());

        view.clear();
        for (const d of docs.items) view.set(d.key, d.value);

        await fetch(`/api/${dataEnv}/subscriptions/${sessionId}/interests`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ interests: [...view.keys()].map((key) => ({ type, key })) }),
        });
        render(view);
    }

    es.addEventListener('subscription:open', (e) => {
        sessionId = JSON.parse(e.data).sessionId; // accept the server's id
        sessionStorage.setItem('subId', sessionId);
        resync(); // initial set = a client query
    });

    // Reconnect → re-run queries + PUT-replace interests.
    es.addEventListener('subscription:resync', () => resync());

    // Signal → refetch the one key, reconcile the local view.
    es.addEventListener('signal', async (e) => {
        const { key } = JSON.parse(e.data);
        const res = await fetch(`/api/${dataEnv}/types/${type}/${key}`);
        if (res.status === 404) {
            view.delete(key); // leave: deregister the interest
            await control('POST', { remove: [{ type, key }] });
        } else {
            const doc = await res.json();
            if (matches(doc.value, filter)) {
                if (!view.has(key)) await control('POST', { add: [{ type, key }] }); // enter
                view.set(key, doc.value);
            } else if (view.has(key)) {
                view.delete(key); // edited out → leave
                await control('POST', { remove: [{ type, key }] });
            }
        }
        render(view);
    });

    function control(method, body) {
        return fetch(`/api/${dataEnv}/subscriptions/${sessionId}/interests`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    return () => es.close(); // DELETE …/:id also closes server-side; close() lets TTL reap.
}
```

Key contract points the client must honour:

- **Register before refetch** on an enter candidate — register the provisional interest
  first, then refetch; if the doc no longer matches, deregister and don't show it. This
  closes the race where a change arrives in the refetch window.
- **Deregister on leave** — when a key leaves the view, remove its interest.
- **PUT-replace on reconnect/resync** — re-declare the whole set; never additively
  re-register.
- **Tolerate coalesced signals** — refetch is idempotent; the view converges to current
  state.

## Storage (`~sub` env)

Subscription state lives in a dedicated environment named `~sub`, opened `sync:false`:

- **`session`** — `{ sessionId, dataEnv, type, filter?, version, createdAt, expiresAt }`,
  with per-doc TTL on `expiresAt`.
- **`interest`** — `{ id, sessionId, type, key }`, with a `ref sessionId → session`,
  `onDelete: cascade`, and a reverse index on `[type, key]` for O(interested sessions)
  routing.

The `~sub` _env_ name starts with `~` so its writes stay out of the data change-feed, while
the non-`~` type names keep FK cascade and TTL working. `sync:false` keeps machine-bound
session/heartbeat churn off replication; the path-local POKE still fires for control
re-notify. The `~sub` env has no changelog (it is read by key/index, never tailed).
