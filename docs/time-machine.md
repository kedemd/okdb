# Time Machine

Time Machine tracks the change history of individual documents. For each tracked type, it records field-level diffs whenever a document is created, updated, or deleted — so you can reconstruct the exact value of any document at any past point in time.

## Overview

Time Machine works at the **type** level. You opt in a type for tracking; from that moment, writes to that type are recorded as diffs against the previous state. Tracking is non-blocking and asynchronous — a per-type `single` processor drains the change log after the fact (debounced by `flushDelayMs`, default 1000 ms), so writes are not slowed down. Because it drains the deduplicated change log in batches, several writes to the same key that land within one drain collapse into a single diff.

Time Machine is an **opt-in constructor feature**: `env.timeMachine` exists only when the instance is constructed with `timeMachine` set (`true`, or an options object). Without it, `env.timeMachine` is `undefined` and the HTTP routes answer 404 ("Time machine not available"). The `okdb` CLI server turns it on by default (set `"timeMachine": false` in the config file to disable). It is also skipped for `~`-prefixed system envs and when the active license does not include the `timeMachine` feature.

```js
const db = new OKDB('./mydb', { timeMachine: true }); // or { timeMachine: { flushDelayMs: 1000 } }
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
const { diffs, head } = env.timeMachine.getHistory('Order', 'order-42', {
    limit: 50, // max entries, oldest first (optional)
    maxClock: someClock, // only diffs at or before this clock (optional)
    after: someClock, // only diffs after this clock (optional)
});
// diffs: [{ clock, fromClock, timestamp, put: {...}, delete: [...] }, ...]   (ascending by clock)
// head:  { value, clock } — the latest tracked value, or null (deleted / never tracked)
```

The JS option for the upper bound is `maxClock` (the HTTP route's `before` query param maps to it — passing `before` to the JS method is ignored).

Each diff entry describes what changed at that clock:

- `put` — fields that were set or updated (nested paths for schema-aware types)
- `delete` — field paths that were removed
- `clock` — the env change-log clock the diff was recorded at (not an HLC value)
- `fromClock` — the clock of the previous diff (0 for the first one)
- `timestamp` — wall-clock time (ms) the diff was recorded

### Point-in-time reconstruction

```js
const value = env.timeMachine.getStateAt('Order', 'order-42', targetClock);
// Returns the document value as of `targetClock` (inclusive), or undefined if no diff exists at or before it
```

### Change log across types

```js
const changes = [...env.timeMachine.getChanges('Order', fromClock, toClock)];
// Or all types:
const allChanges = [...env.timeMachine.getChanges(null, fromClock, toClock)];
// Each: { clock, type, key, put, delete, fromClock, timestamp } — both bounds inclusive
```

## Inspecting status

```js
// Per-type status
const status = env.timeMachine.status('Order');
// {
//   type: 'Order',
//   enabled: true,           // a processor is registered in this instance
//   startClock: 1234567,
//   lastProcessedClock: 9876543,
//   headCount: 412,
//   ...processorStatus       // state, lag, lastClock, mode, … (when enabled)
// }

// Summary across all types
const summary = env.timeMachine.status();
// { enabled, autoEnable, startClock, lastProcessedClock, envClock, headCount, disabledAt, types: [...] }

// Check if a type is enabled
env.timeMachine.isEnabled('Order'); // boolean

// List every non-system type in the env with its tracking state (sorted by name)
env.timeMachine.list();
// [{ type: 'Order', enabled: true, state: 'online', lastClock: ..., lag: 0 }, ...]
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

Query params for `/history`: `limit`, `before` (max clock, inclusive), `after` (min clock, exclusive). The response is the `{ diffs, head }` object. `/at/:clock` returns `{ value, clock }`, or 404 when no state exists at that clock. `/changes` defaults `from` to 0 and `to` to the end of the log.

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
