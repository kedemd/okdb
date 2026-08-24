# TTL (Time-to-Live)

OKDB supports per-record TTL — set an expiration on any item and it will be automatically removed after the specified duration.

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

### `getTTL(type, key)`

Returns the TTL info for an item, or `null` if no TTL is set.

| Parameter | Type     | Description            |
| --------- | -------- | ---------------------- |
| `type`    | `string` | The type name          |
| `key`     | `string` | The item's primary key |

**Returns:** `{ expiresAt: number, remainingMs: number } | null`

- `expiresAt` — absolute Unix timestamp (ms) when the item expires
- `remainingMs` — milliseconds until expiration (0 if already expired but not yet swept)

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

Returns aggregate TTL statistics for the default environment, optionally filtered to a single type.

| Parameter | Type     | Description                                |
| --------- | -------- | ------------------------------------------ |
| `type`    | `string` | _(optional)_ Filter stats to a single type |

**Returns:** `{ enabled, totalEntries, expiredEntries, nextExpiry, byType }`

| Field            | Type           | Description                                         |
| ---------------- | -------------- | --------------------------------------------------- |
| `enabled`        | `boolean`      | Whether any TTL sub-databases exist                 |
| `totalEntries`   | `number`       | Total number of TTL entries                         |
| `expiredEntries` | `number`       | Entries that have already expired but not yet swept |
| `nextExpiry`     | `number\|null` | Timestamp (ms) of the soonest expiry, or `null`     |
| `byType`         | `object`       | `{ [typeName]: count }` breakdown                   |

```javascript
const stats = db.ttlStats();
// { enabled: true, totalEntries: 15, expiredEntries: 2,
//   nextExpiry: 1712345678000, byType: { sessions: 10, cache: 5 } }

const sessionStats = db.ttlStats('sessions');
// filtered to sessions only
```

### `listTTL(opts?)`

Lists all TTL entries sorted by expiry time (soonest first).

| Parameter     | Type     | Description                                   |
| ------------- | -------- | --------------------------------------------- |
| `opts.type`   | `string` | _(optional)_ Filter to a single type          |
| `opts.limit`  | `number` | _(optional, default 100)_ Max items to return |
| `opts.offset` | `number` | _(optional, default 0)_ Skip this many items  |

**Returns:** `{ total, items }`

Each item: `{ type, key, expiresAt, remainingMs }`

```javascript
const result = db.listTTL({ type: 'sessions', limit: 10 });
// { total: 42, items: [ { type: 'sessions', key: 's1', expiresAt: ..., remainingMs: ... }, ... ] }
```

---

## Background Sweep

Expired items are not deleted the instant they expire. Instead, they are removed by a background sweep timer or by calling `sweepExpiredTTL()` manually.

### Start / Stop

```javascript
const env = db.env('default');

// Sweep every 60 seconds (default)
env.startTTLSweep();

// Sweep every 10 seconds
env.startTTLSweep(10_000);

// Stop the background sweep
env.stopTTLSweep();
```

The sweep timer is automatically stopped when the database is closed. The timer is created with `unref()` so it won't keep your process alive.

### Sweep Behaviour

- Iterates all types, scanning the TTL index for entries where `expiresAt <= Date.now()`
- Removes each expired item using the standard `_remove()` path (indexes, foreign keys, change log all updated)
- Emits a `ttl:expired` event for each removed item
- Respects `batchSize` to avoid long-running transactions
- Safe to call concurrently — duplicate removal attempts are handled gracefully

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

```javascript
const { EVENTS } = require('okdb/okdb-enums');

db.events.on(EVENTS.TTL_EXPIRED, ({ type, key }) => {
    console.log(`Expired: ${type}/${key}`);
});
```

---

## HTTP API

### Get item TTL

```
GET /api/:env/type/:type/item/:key/ttl
```

Returns `{ result: { expiresAt, remainingMs } }` or `{ result: null }`.

### Set item TTL

```
PUT /api/:env/type/:type/item/:key/ttl
Content-Type: application/json

{ "ttl": 60000 }
```

### Clear item TTL

```
DELETE /api/:env/type/:type/item/:key/ttl
```

### Put item with TTL

The standard PUT item route accepts an optional `ttl` field:

```
PUT /api/:env/type/:type/item/:key
Content-Type: application/json

{ "value": { "user": "alice" }, "ttl": 60000 }
```

### Sweep expired items

```
POST /api/:env/ttl/sweep
Content-Type: application/json

{ "batchSize": 500 }
```

Returns `{ result: { removed: 5, types: { sessions: 3, cache: 2 } } }`.

### TTL stats

```
GET /api/:env/ttl/stats
GET /api/:env/ttl/stats?type=sessions
```

Returns `{ result: { enabled, totalEntries, expiredEntries, nextExpiry, byType } }`.

### List TTL entries

```
GET /api/:env/ttl/list
GET /api/:env/ttl/list?type=sessions&limit=20&offset=0
```

Returns `{ result: { total, items: [{ type, key, expiresAt, remainingMs }] } }`.

### GET item includes TTL

When a TTL is set on an item, the `GET /api/:env/type/:type/item/:key` response includes it:

```json
{
    "result": {
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
await analytics.setTTL('events', 'e1', 86_400_000); // 24h

analytics.startTTLSweep(60_000); // independent sweep timer
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

Each registered type gets two additional LMDB sub-databases:

| Sub-database      | Key                          | Value                         | Purpose                        |
| ----------------- | ---------------------------- | ----------------------------- | ------------------------------ |
| `type:T:ttl`      | `expiresAt` (ordered-binary) | `primaryKey` (ordered-binary) | Range scan for sweep (dupSort) |
| `type:T:ttlByKey` | `primaryKey`                 | `expiresAt`                   | O(1) lookup for get/clear      |

- **Setting a TTL** writes to both sub-databases. If a previous TTL exists, the old entry in `ttl` is removed first.
- **Clearing a TTL** removes from both sub-databases.
- **Removing an item** (`db.remove()`) automatically clears its TTL entries.
- **Updating an item** (`db.put()`, `db.update()`) does **not** change its TTL. The TTL must be explicitly updated with `setTTL()`.
- **Sweeping** does a range scan on `type:T:ttl` for all entries where `expiresAt <= now`, then removes the corresponding items.

---

## Persistence

TTL metadata is stored in LMDB alongside the data. It survives restarts — items that expired while the database was closed will be swept on the next `sweepExpiredTTL()` call (or by the background timer).

---

## Use Cases

- **Session management** — expire user sessions after inactivity
- **Cache layer** — use OKDB as a persistent cache with automatic eviction
- **Rate limiting** — store rate-limit counters with short TTLs
- **Temporary data** — upload staging, preview tokens, OTP codes
- **CDN-like caching** — serve cached responses with configurable freshness
