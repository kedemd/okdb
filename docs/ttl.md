# TTL (Time-to-Live)

OKDB supports per-record TTL — set an expiration on any item and it will be automatically removed after the specified duration. Removal is done by a sweep, not at read time — see [Expired but not yet swept](#expired-but-not-yet-swept).

---

## Quick Start

```javascript
const OKDB = require('@kedem/okdb');
const db = new OKDB('./my-data');
await db.open();

await db.registerType('sessions');
await db.put('sessions', 's1', { user: 'alice', token: 'abc123' });

// Expire this session in 30 minutes
await db.setTTL('sessions', 's1', 30 * 60 * 1000);

// Check remaining time
const ttl = db.getTTL('sessions', 's1');
// { expiresAt: 1712345678000, remainingMs: 1799432 }

// Make the item permanent again
await db.clearTTL('sessions', 's1');
```

---

## API Reference

### `setTTL(type, key, ttlMs)`

Sets a TTL on an existing item. The item will be eligible for removal after `ttlMs` milliseconds from now.

| Parameter | Type     | Description                                     |
| --------- | -------- | ----------------------------------------------- |
| `type`    | `string` | The type (collection) name                      |
| `key`     | `string` | The item's primary key                          |
| `ttlMs`   | `number` | Time-to-live in milliseconds (must be positive) |

**Throws:**

- `OKDBNotFoundError` if the item doesn't exist
- `OKDBInvalidValueError` if `ttlMs` is not a positive number

```javascript
await db.setTTL('cache', 'page:/home', 60_000); // expire in 1 minute
```

Calling `setTTL` on an item that already has a TTL replaces the previous expiration.

A TTL can also be given at write time — `put` / `update` / `patch` / `create` accept a `ttl`
option (ms):

```javascript
await db.put('cache', 'page:/home', html, { ttl: 60_000 });
```

### `setDefaultTTL(type, ttlMs)` / `getDefaultTTL(type)` / `clearDefaultTTL(type)`

A per-type default TTL, applied to items **created** in that type without an explicit `ttl`
(updates of an existing item do not re-apply it). Available on an env
(`db.env('default').setDefaultTTL('sessions', 30 * 60 * 1000)`).

### `getTTL(type, key)`

Returns the TTL info for an item, or `null` if no TTL is set.

| Parameter | Type     | Description            |
| --------- | -------- | ---------------------- |
| `type`    | `string` | The type name          |
| `key`     | `string` | The item's primary key |

**Returns:** `{ expiresAt: number, remainingMs: number } | null`

- `expiresAt` — absolute Unix timestamp (ms) when the item expires
- `remainingMs` — milliseconds until expiration (0 if already expired but not yet swept)

`getTTL` throws `OKDBTypeNotRegisteredError` for an unknown type.

```javascript
const ttl = db.getTTL('cache', 'page:/home');
if (ttl && ttl.remainingMs < 5000) {
    console.log('About to expire!');
}
```

### `clearTTL(type, key)`

Removes the TTL from an item, making it permanent. The item itself is not deleted.

```javascript
await db.clearTTL('sessions', 's1');
```

### `sweepExpiredTTL(batchSize?)`

Manually triggers a sweep of all expired items across all types.

| Parameter   | Type     | Default | Description                            |
| ----------- | -------- | ------- | -------------------------------------- |
| `batchSize` | `number` | `1000`  | Max items to remove per type per sweep |

**Returns:** `{ removed: number, types: { [typeName]: number } }`

```javascript
const result = await db.sweepExpiredTTL();
console.log(`Removed ${result.removed} expired items`);
// result.types = { sessions: 3, cache: 12 }
```

### `ttlStats(type?)`

Returns aggregate TTL statistics for the default environment (`env.ttlStats()` for any other), optionally filtered to a single type.

| Parameter | Type     | Description                                |
| --------- | -------- | ------------------------------------------ |
| `type`    | `string` | _(optional)_ Filter stats to a single type |

**Returns:** `{ enabled, totalEntries, expiredEntries, nextExpiry, byType }`

| Field            | Type           | Description                                          |
| ---------------- | -------------- | ---------------------------------------------------- |
| `enabled`        | `boolean`      | Whether the env's TTL sub-databases exist            |
| `totalEntries`   | `number`       | Total number of TTL entries                          |
| `expiredEntries` | `number`       | Entries that have already expired but not yet swept  |
| `nextExpiry`     | `number\|null` | This process's cached soonest expiry (ms), or `null` |
| `byType`         | `object`       | `{ [typeName]: count }` breakdown                    |

```javascript
const stats = db.ttlStats();
// { enabled: true, totalEntries: 15, expiredEntries: 2,
//   nextExpiry: 1712345678000, byType: { sessions: 10, cache: 5 } }

const sessionStats = db.ttlStats('sessions');
// filtered to sessions only
```

### `listTTL(opts?)`

Lists all TTL entries sorted by expiry time (soonest first).

| Parameter    | Type     | Description                                   |
| ------------ | -------- | --------------------------------------------- |
| `opts.type`  | `string` | _(optional)_ Filter to a single type          |
| `opts.limit` | `number` | _(optional, default 100)_ Max items to return |

There is no offset — `total` counts every matching entry, `items` holds the first `limit`.

**Returns:** `{ total, items }`

Each item: `{ type, key, expiresAt, remainingMs, expired }`

```javascript
const result = db.listTTL({ type: 'sessions', limit: 10 });
// { total: 42, items: [ { type: 'sessions', key: 's1', expiresAt: ..., remainingMs: ..., expired: false }, ... ] }
```

---

## Background Sweep

Expired items are not deleted the instant they expire. They are removed by an automatic,
per-env sweep, or by calling `sweepExpiredTTL()` manually. There is no start/stop API and no
fixed interval — the sweep is scheduled from each process's in-memory "soonest expiry":

- **A timer** — one per env — is armed for the soonest expiry when the env opens (if it has TTL
  entries), whenever a TTL is set in this process by any path (`setTTL()`, a write option
  `put(..., { ttl })`, a type default, the HTTP PUT body's `ttl`) and it is earlier than the
  armed target, when a replicated TTL is applied from a sync peer, and after every sweep for the
  next remaining expiry. It is `unref()`'d, so it never keeps the process alive, and it is
  cancelled on close.
- **Every write** to the env in this process checks (in memory, no I/O) whether the soonest
  expiry has passed and, if so, queues a sweep.

Every process that has the env open runs this — it is not tied to the `processors` role or a
lease. Concurrent sweeps from several processes are safe: each re-checks the entry inside its
write transaction and skips items another process already removed.

### Sweep Behaviour

- Range-scans the env-level `~ttl:expiry` index for entries where `expiresAt <= Date.now()`
  (all types at once), up to `batchSize` (default 1000) per sweep, in one write transaction
- Removes each expired item using the standard remove path (indexes, foreign keys, change log all updated)
- Emits a `ttl:expired` event for each removed item
- Skips (and cleans up) entries whose TTL was changed or cleared since the scan

### Expired but not yet swept

Reads do **not** check TTL. Until a sweep removes it, an expired item is still returned by
every read path — `get`, `getEntry`, `query`, index lookups, views, FTS, and the HTTP routes;
`getTTL` then reports `remainingMs: 0`. The window is normally short:

- the timer fires at the soonest expiry; the sweep then takes a write transaction, so removal
  lands shortly after `expiresAt`, not exactly at it;
- a sweep removes at most `batchSize` items; if more are already due, the timer is re-armed
  immediately for the next batch;
- an item whose removal is refused (e.g. a foreign-key `onDelete: 'restrict'` child still
  references it) stays until the removal succeeds; while only such items are due, sweeps back
  off (1 s, doubling to 10 s) instead of retrying continuously, which can also delay other expiries
  by up to the backoff;
- TTLs written by another process on the same path do not update this process's soonest expiry
  (that process sweeps them itself).

If expiry must be exact, filter on the read side (compare `getTTL(...).remainingMs` or keep an
`expiresAt` field in the document), or call `sweepExpiredTTL()` / `POST .../ttl/sweep` before
reading.

---

## Transactions

TTL operations can be included in batch transactions for atomic create-and-expire patterns:

```javascript
const txn = db.transaction();

txn.put('sessions', 's1', { user: 'alice', token: 'abc123' });
txn.setTTL('sessions', 's1', 30 * 60 * 1000); // 30 min

txn.put('sessions', 's2', { user: 'bob', token: 'xyz789' });
txn.setTTL('sessions', 's2', 60 * 60 * 1000); // 1 hour

await txn.commit(); // both items and their TTLs set atomically
```

Also works with the `txn()` helper:

```javascript
await db.txn(async (t) => {
    t.put('cache', 'k1', { data: 'hello' });
    t.setTTL('cache', 'k1', 30_000);
});
```

Clear TTL within a transaction:

```javascript
const txn = db.transaction();
txn.clearTTL('sessions', 's1');
await txn.commit();
```

---

## Events

TTL operations emit events on `db.events`:

| Event         | Payload                         | When                            |
| ------------- | ------------------------------- | ------------------------------- |
| `ttl:set`     | `{ type, key, expiresAt, env }` | A TTL is set or updated         |
| `ttl:clear`   | `{ type, key, env }`            | A TTL is cleared                |
| `ttl:expired` | `{ type, key, env }`            | An item is removed by the sweep |

`ttl:set` / `ttl:clear` payloads are the changelog entry, so they also carry `clock`, `origin`,
`action` and `timestamp`.

```javascript
db.events.on('ttl:expired', ({ type, key }) => {
    console.log(`Expired: ${type}/${key}`);
});
```

---

## HTTP API

### Get item TTL

```
GET /api[/env/:env]/type/:type/item/:key/ttl
```

Returns `{ data: { expiresAt, remainingMs } }` or `{ data: null }` (inside okdb's usual
`{ data, error, meta }` envelope). Env-scoped routes take an optional `/env/:env` segment;
without it they target the default env — see [HTTP API](./http-api.md#environment-prefix).

### Set item TTL

```
PUT /api[/env/:env]/type/:type/item/:key/ttl
Content-Type: application/json

{ "ttl": 60000 }
```

### Clear item TTL

```
DELETE /api[/env/:env]/type/:type/item/:key/ttl
```

### Put item with TTL

The standard PUT item route stores the **whole request body** as the document; a numeric
top-level `ttl` field (> 0) is also applied as the TTL in ms:

```
PUT /api[/env/:env]/type/:type/item/:key
Content-Type: application/json

{ "user": "alice", "ttl": 60000 }
```

Because the body is the document, `ttl: 60000` is stored in the document as well. To keep it
out, write the item and then call `PUT .../item/:key/ttl`.

### Per-type default TTL

```
GET    /api[/env/:env]/type/:type/ttl/default      → { type, defaultTTL }
PUT    /api[/env/:env]/type/:type/ttl/default      { "ttl": 60000 }
DELETE /api[/env/:env]/type/:type/ttl/default
```

### Sweep expired items

```
POST /api[/env/:env]/ttl/sweep
Content-Type: application/json

{ "batchSize": 500 }
```

Returns `{ data: { removed: 5, types: { sessions: 3, cache: 2 } } }`.

### TTL stats

```
GET /api[/env/:env]/ttl/stats
GET /api[/env/:env]/ttl/stats?type=sessions
```

Returns `{ data: { enabled, totalEntries, expiredEntries, nextExpiry, byType } }`.

### List TTL entries

```
GET /api[/env/:env]/ttl/list
GET /api[/env/:env]/ttl/list?type=sessions&limit=20
```

Returns `{ data: { total, items: [{ type, key, expiresAt, remainingMs, expired }] } }` (`limit`
default 100, max 1000).

### GET item includes TTL

When a TTL is set on an item, the `GET /api[/env/:env]/type/:type/item/:key` response includes it:

```json
{
    "data": {
        "key": "s1",
        "value": { "user": "alice" },
        "ttl": { "expiresAt": 1712345678000, "remainingMs": 1799432 }
    }
}
```

---

## Environments

TTL works independently per environment:

```javascript
await db.createEnvironment('analytics');
const analytics = db.env('analytics');

await analytics.registerType('events');
await analytics.put('events', 'e1', { name: 'pageview' });
await analytics.setTTL('events', 'e1', 86_400_000); // 24h — swept by analytics' own scheduler
```

---

## Stored Functions

TTL methods are available in the stored function facade:

```javascript
// Inside a stored function
async function handler({ db }) {
    await db.setTTL('sessions', key, 30 * 60 * 1000);
    const ttl = db.getTTL('sessions', key);
    await db.clearTTL('sessions', key);
    await db.sweepExpiredTTL();
}
```

---

## How It Works

Each env has one TTL store shared by all its types — two LMDB sub-databases, created lazily on
the first TTL write (a `_ttl_enabled` flag reopens them on restart):

| Sub-database  | Key                          | Value                   | Purpose                   |
| ------------- | ---------------------------- | ----------------------- | ------------------------- |
| `~ttl:expiry` | `expiresAt` (ordered-binary) | `"type\tkey"` (dupSort) | Range scan for sweep      |
| `~ttl:key`    | `"type\tkey"`                | `expiresAt`             | O(1) lookup for get/clear |

- **Setting a TTL** writes to both sub-databases. If a previous TTL exists, the old entry in `~ttl:expiry` is removed first.
- **Clearing a TTL** removes from both sub-databases.
- **Removing an item** (`db.remove()`) automatically clears its TTL entries; dropping a type clears all of its TTL entries.
- **Updating an item** (`db.put()`, `db.update()`) does **not** change its TTL unless the write passes a `ttl` option. Otherwise the TTL must be explicitly updated with `setTTL()`.
- **Sweeping** does a range scan on `~ttl:expiry` for all entries where `expiresAt <= now`, then removes the corresponding items.
- **Sync**: `setTTL` / `clearTTL` write changelog entries (`setTtl` / `clearTtl`) carrying the absolute `expiresAt`, so TTLs replicate to peers.

---

## Persistence

TTL metadata is stored in LMDB alongside the data. It survives restarts — items that expired while the database was closed are swept soon after the env reopens (the open arms the timer for the soonest expiry, which is already due), or on the next `sweepExpiredTTL()` call.

---

## Use Cases

- **Session management** — expire user sessions after inactivity
- **Cache layer** — use OKDB as a persistent cache with automatic eviction
- **Rate limiting** — store rate-limit counters with short TTLs
- **Temporary data** — upload staging, preview tokens, OTP codes
- **CDN-like caching** — serve cached responses with configurable freshness
