# Time Machine

Time Machine tracks the change history of individual documents. For each tracked type, it records field-level diffs whenever a document is created, updated, or deleted — so you can reconstruct the exact value of any document at any past point in time.

## Overview

Time Machine works at the **type** level. You opt in a type for tracking; from that moment, every write to that type is recorded as a diff against the previous state. Tracking is non-blocking and asynchronous — writes are not slowed down.

```js
const db = new OKDB('./mydb');
await db.open();
const env = db.env('myenv');

// Enable tracking for a single type
await env.timeMachine.enable('Order');

// Or enable tracking for all current and future types
await env.timeMachine.enableAll();
```

## Enabling and disabling

### Per-type control

```js
await env.timeMachine.enable('Order'); // start tracking
await env.timeMachine.disable('Order'); // stop tracking, keep history
await env.timeMachine.drop('Order'); // stop tracking, delete all history
```

`disable()` stops recording new diffs but leaves the full history intact. Future `enable()` calls resume from where tracking stopped — no gaps, no re-seed.

`drop()` deletes all stored diffs and heads for the type and resets the cursor. The next `enable()` will perform a fresh initial snapshot.

### Env-wide control

```js
await env.timeMachine.enableAll(); // enable all registered types now + auto-enable future types
await env.timeMachine.disableAll(); // stop all tracking, clear auto-enable flag
```

When `enableAll()` is called, all types registered at that moment are enabled. Any type registered afterward is also automatically enabled (via a `TYPE_REGISTERED` listener).

## Querying history

### Full history for a key

```js
const history = env.timeMachine.getHistory('Order', 'order-42', {
    limit: 50, // max entries (optional)
    before: someClock, // only diffs at or before this clock (optional)
    after: someClock, // only diffs after this clock (optional)
});
// Returns: [{ clock, fromClock, timestamp, put: {...}, delete: [...] }, ...]
```

Each entry describes what changed at that clock:

- `put` — fields that were set or updated (nested paths for schema-aware types)
- `delete` — field paths that were removed
- `clock` — HLC timestamp of the change
- `fromClock` — the previous clock value (0 for the initial snapshot)
- `timestamp` — wall-clock time the diff was recorded

### Point-in-time reconstruction

```js
const value = env.timeMachine.getStateAt('Order', 'order-42', targetClock);
// Returns the document value at `targetClock`, or undefined if not found
```

### Change log across types

```js
const changes = [...env.timeMachine.getChanges('Order', fromClock, toClock)];
// Or all types:
const allChanges = [...env.timeMachine.getChanges(null, fromClock, toClock)];
```

## Inspecting status

```js
// Per-type status
const status = env.timeMachine.status('Order');
// {
//   type: 'Order',
//   enabled: true,
//   startClock: 1234567,
//   lastProcessedClock: 9876543,
//   headCount: 412,
//   enabledAt: 1716300000000,
// }

// Summary across all types
const summary = env.timeMachine.status();
// { enabled: true, autoEnable: true, types: [...] }

// Check if a type is enabled
env.timeMachine.isEnabled('Order'); // boolean

// List all tracked types
env.timeMachine.list();
// [{ type: 'Order', enabled: true, startClock: ..., ... }, ...]
```

## HTTP API

### Per-type management

| Method | Route                                            | Description        |
| ------ | ------------------------------------------------ | ------------------ |
| GET    | `/api/env/:env/time-machine`                     | Summary status     |
| GET    | `/api/env/:env/time-machine/types`               | List tracked types |
| GET    | `/api/env/:env/time-machine/types/:type`         | Per-type status    |
| POST   | `/api/env/:env/time-machine/types/:type/enable`  | Enable tracking    |
| POST   | `/api/env/:env/time-machine/types/:type/disable` | Disable tracking   |
| POST   | `/api/env/:env/time-machine/types/:type/drop`    | Drop history       |
| POST   | `/api/env/:env/time-machine/enable-all`          | Enable all types   |
| POST   | `/api/env/:env/time-machine/disable-all`         | Disable all types  |

### Query routes

| Method | Route                                                   | Description       |
| ------ | ------------------------------------------------------- | ----------------- |
| GET    | `/api/env/:env/time-machine/:type/:key/history`         | History for a key |
| GET    | `/api/env/:env/time-machine/:type/:key/at/:clock`       | State at a clock  |
| GET    | `/api/env/:env/time-machine/changes?type=T&from=N&to=M` | Change log        |

History and point-in-time routes return 409 if the requested type is not currently enabled.

Query params for `/history`: `limit`, `before` (max clock, inclusive), `after` (min clock, exclusive).

## Schema-aware diffs

When a type has a registered schema with nested object properties, Time Machine records diffs at the path level rather than the field level. For example, if `User.address` is a nested object:

```
// Before: { name: 'Alice', address: { city: 'NYC', zip: '10001' } }
// After:  { name: 'Alice', address: { city: 'LA',  zip: '10001' } }

// Diff records:
// put: { 'address.city': 'LA' }
// (not: { address: { city: 'LA', zip: '10001' } })
```

## Storage

Time Machine stores data in a dedicated LMDB environment at `<env-path>/time-machine/` with four sub-DBs:

- `head` — current snapshot of each tracked document (`[type, key]` → `{ value, clock }`)
- `diffs` — ordered-binary keyed diffs (`[type, key, clock]` → diff data)
- `clockToKeys` — reverse index from clock to keys changed at that clock
- `config` — per-type enabled state, auto-enable flag, and migration metadata

Processor cursors (the HLC watermark for each type's change stream) are stored in `~proc:state`, not in the time-machine sub-env.

## Migration from the old per-env API

Before version 1.7, Time Machine was enabled env-wide with `env.timeMachine.enable()` / `env.timeMachine.disable()`. This API is now **deprecated** and will be removed in a future release.

**What changed:**

| Old                                        | New                                               |
| ------------------------------------------ | ------------------------------------------------- |
| `enable()`                                 | `enable(type)` or `enableAll()`                   |
| `disable()`                                | `disable(type)` or `disableAll()`                 |
| `drop()`                                   | `drop(type)` or `dropAll()`                       |
| `isEnabled()`                              | `isEnabled(type)` or `isEnabled()` (any enabled?) |
| `POST /api/env/:env/time-machine/enable`   | `POST /api/env/:env/time-machine/enable-all`      |
| `DELETE /api/env/:env/time-machine/enable` | `POST /api/env/:env/time-machine/disable-all`     |
| `GET /api/env/:env/time-machine/status`    | `GET /api/env/:env/time-machine`                  |

**Automatic migration:** on first open after upgrading, OKDB detects the old per-env config and automatically migrates it to the per-type model. All previously tracked types are re-enabled with their history intact, and each type's processor cursor is set to the old global cursor value. This is one-shot and idempotent.

The deprecated no-arg forms (`enable()`, `disable()`, `drop()`) still work and log a deprecation warning once per process. They delegate to `enableAll()` / `disableAll()` / `dropAll()` respectively. Update your code before the next major release.

See `UPGRADING.md` for the full migration guide.
