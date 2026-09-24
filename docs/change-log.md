# Change Log & Events

Every write in OKDB — put, remove, registerType, registerIndex — increments a monotonic integer **clock** and appends an entry to the change log. This is the backbone of sync, the processor system, and reactive change handling.

---

## The clock

A per-environment monotonic integer. Starts at 0, increments by 1 for every logged change (each put or remove inside a transaction gets its own clock). The clock is shared across processes open on the same path.

```javascript
// Current clock value
const clock = okdb.getClock();

// Per-type clock (highest clock seen for that type)
const usersClock = okdb.getClock('users');
```

---

## Reading the change log

```javascript
// Get changes between clock 100 and 200 (both inclusive).
// Returns a lazy iterable over a pinned snapshot — consume it synchronously
// (holding it across an `await` throws READER_HELD_ACROSS_AWAIT; see querying.md).
const changes = okdb.getChanges(null, 100, 200);
for (const change of changes) {
    console.log(change);
    // {
    //   clock:     142,
    //   id:        'item:users@alice',
    //   type:      'users',
    //   key:       'alice',
    //   action:    'put',           // 'put' | 'remove' | 'registerType' | 'dropType' | 'registerIndex' | 'dropIndex' | 'resetIndex' | 'setSchema' | …
    //   timestamp: 1833234737026049, // HLC value (wall-clock ms * 1024 + logical counter)
    //   origin:    'node-uuid',
    //   txnId:     'txn-uuid',
    // }
}

// Changes for a specific type only
const userChanges = okdb.getChanges('users', 0, okdb.getClock());
```

:::note Deduplication
The change log keeps only the **most recent** entry per primary key. If you write to `users/alice` three times, only the last write appears in the log. This is intentional — `getChanges` returns "what is the current state delta", not a full history.
:::

---

## Events

OKDB emits events on `okdb.events` (a standard Node.js `EventEmitter`) after each transaction commits.

### Data events

```javascript
okdb.events.on('item:create', ({ env, type, key, newValue, clock, origin }) => {
    console.log(`Created ${type}/${key}`);
});

okdb.events.on('item:update', ({ type, key, newValue, oldValue, clock }) => {
    console.log(`Updated ${type}/${key}`);
});

okdb.events.on('item:remove', ({ type, key, oldValue, clock }) => {
    console.log(`Removed ${type}/${key}`);
});
```

### System events

```javascript
okdb.events.on('system:clock_change', ({ clock, type }) => { ... });
okdb.events.on('system:clock_change@users', () => { ... }); // type-specific — emitted with no payload
okdb.events.on('system:ready', (okdb) => { ... });
okdb.events.on('system:stopped', () => { ... });
okdb.events.on('env:opened', ({ name, env }) => { ... });
```

`okdb.events` is one emitter shared by every env (`env.events === okdb.events`); data-event payloads carry `env` so you can tell them apart. The events are in-process only — for writes made by other processes on the same path, use a processor with `originMode: 'all'` or the SSE subscriptions API.

Events fire **after** the LMDB transaction is durably committed. Listeners never see speculative data.

:::warning Backpressure
Events are emitted synchronously via `EventEmitter`. A slow listener blocks subsequent event delivery. For heavy processing, use the **Processor** system instead.
:::

---

## Processor

The Processor is OKDB's reactive change handler — a durable, leased consumer of the change log. See [Processors](processors.md) for the full model (modes, leases, cursors, runtime mode switching).

Think of it as event listeners with superpowers: they can filter by origin, run in-commit or async, resume from a durable cursor after a restart, and are managed as named, stoppable handlers.

### Registering a handler

Handlers are **named, not bare closures** — every process that registers the processor must be able to reconstruct it. Put the handler in a module:

```javascript
// ./fulfillment.js
exports.apply = async (ctx, changes, info) => {
    for (const ch of changes) {
        if (ch.action !== 'put') continue;
        if (ch.value?.status === 'paid') {
            await scheduleShipment(ch.key, ch.value);
        }
    }
};

// registration
const stop = okdb.env('default').processor.register('orders', {
    name: 'orders:fulfillment', // human-readable name
    cursorKey: 'orders:fulfillment', // durable resume position
    mode: 'async', // default — 1-of-N, leased, durable cursor
    originMode: 'all', // 'self' (default) | 'remote' | 'all'
    module: { path: require.resolve('./fulfillment.js'), export: 'apply' },
});

// Stop the handler
await stop();
```

Passing `handler: async (changes) => …` (a bare closure) throws. The alternative to `module` is `handler: '<name>'` for a function registered with `OKDBProcessor.registerHandler(name, fn)` — see [Processors](processors.md#registering-a-processor).

### Register options reference

| Option               | Type      | Default    | Description                                                                                                                                                                                                                                   |
| -------------------- | --------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module`             | `object`  | —          | `{ path, export }` — file handler, called as `fn(ctx, changes[], info)` with `ctx = { env, payload }`. Exactly one of `module` / `handler` is required.                                                                                       |
| `handler`            | `string`  | —          | Name of a function registered with `OKDBProcessor.registerHandler(name, fn)`; same call signature. Bare closures throw.                                                                                                                       |
| `payload`            | `any`     | `null`     | Registration-time value passed to the handler as `ctx.payload`                                                                                                                                                                                |
| `mode`               | `string`  | `'async'`  | `'async'` (background drain) \| `'sync'` (every writer, inside the commit). Deprecated single-string aliases `'single'`/`'worker'`/`'fanout'`/`'inline'` still map with a warning; bare `'async'` is **not** fanout.                          |
| `distribution`       | `string`  | `'single'` | `mode:'async'` only: `'single'` (1-of-N, leased, durable cursor) \| `'fanout'` (N-of-N, per-process in-memory cursor starting at "now")                                                                                                       |
| `bootstrap`          | `string`  | `'log'`    | `'snapshot'` \| `'log'` — how the initial backfill runs                                                                                                                                                                                       |
| `originMode`         | `string`  | `'self'`   | `'all'` \| `'self'` \| `'remote'`                                                                                                                                                                                                             |
| `batchSize`          | `number`  | `256`      | Max changes delivered per handler call                                                                                                                                                                                                        |
| `hydrateValues`      | `boolean` | `true`     | Attach current document value to each change                                                                                                                                                                                                  |
| `cursorKey`          | `string`  | `null`     | Persist the cursor under this key so progress survives restarts                                                                                                                                                                               |
| `lockMode`           | `string`  | `null`     | `'exclusive'` — serialise concurrent flushes for this processor                                                                                                                                                                               |
| `failOnHandlerError` | `boolean` | `false`    | Put the processor into error state on handler exception                                                                                                                                                                                       |
| `flushDebounce`      | `number`  | `0`        | Trailing-edge debounce in ms. Rapid write bursts coalesce into a single flush after `flushDebounce` ms of quiet. `0` = flush immediately (default).                                                                                           |
| `flushInterval`      | `number`  | `null`     | Start a `setInterval` that ticks `_scheduleFlush` every `flushInterval` ms after bootstrap. Useful for polling-style processors or `originMode: 'remote'` subscriptions where local writes don't trigger `_onAfterCommit`. `null` = disabled. |
| `name`               | `string`  | `null`     | Human-readable label shown in admin UI and status                                                                                                                                                                                             |
| `meta`               | `object`  | `{}`       | Arbitrary metadata attached to status objects                                                                                                                                                                                                 |
| `leaseTtlMs`         | `number`  | `30000`    | Lease TTL for cross-process exclusive execution                                                                                                                                                                                               |

`stop.status()` (alias `stop.getStatus()`) returns the live processor state including `flushDebounce` and `flushInterval`. `stop.pause()` clears both timers; `stop.resume()` restarts the interval if configured.

### Change object shape

Async (`single`/`fanout`) handlers receive change-log records:

```javascript
{
    id:        'item:orders@o42',
    type:      'orders',
    key:       'o42',
    action:    'put',          // 'put' | 'remove' | schema actions ('registerType', …)
    value:     { ... },        // current document (hydrateValues: true, put only)
    clock:     182,
    timestamp: 1833234737026049, // HLC
    origin:    'node-uuid',
    txnId:     'txn-uuid',
}
```

`mode: 'sync'` (inline) handlers run inside the commit and receive one record per write carrying `newValue` and `oldValue` instead of `value` (the same payload as the `item:*` events).

### originMode

`origin` is the id of the OKDB instance that made the write (every process has its own, even on the same path).

| Value      | Fires when                                                        |
| ---------- | ----------------------------------------------------------------- |
| `'self'`   | **Default.** Only writes made by this OKDB instance               |
| `'remote'` | Only writes made by other instances (other processes, sync peers) |
| `'all'`    | Any write                                                         |

This is useful for reacting differently to local vs. replicated changes — e.g., sending a notification only when your own node creates a record, not when it receives one from a peer.

**Multi-process deployments:** Async processors with `originMode: 'all'` or `'remote'` automatically subscribe to `EVENTS.SYSTEM_POKE` — the UDP bus's cross-process commit signal. When another process writes to the same LMDB environment, it sends a `POKE` via the bus; the local process receives it and wakes all eligible processors within tens of milliseconds. No configuration is needed — the behavior is automatic based on `originMode`. Processors with `originMode: 'self'` do not subscribe (they explicitly don't care about remote-origin changes).

### Processor on a custom env

Each environment has its own processor:

```javascript
const env = okdb.env('analytics');
const stop = env.processor.register('events', {
    originMode: 'all',
    name: 'analytics:aggregate',
    cursorKey: 'analytics:aggregate',
    module: { path: require.resolve('./aggregate.js'), export: 'apply' },
});
```

---

## HLC timestamps

The `timestamp` field on change objects is a **Hybrid Logical Clock** value: a 64-bit integer encoding both wall-clock milliseconds and a logical counter. HLC values are monotonically increasing even when system clocks skew backwards, which makes them safe for LWW conflict resolution in sync.

```javascript
// Decode an HLC value: physicalTime * 1024 + logicalCounter
const wallMs = Math.floor(change.timestamp / 1024);
const logical = change.timestamp % 1024;
```

You don't need to manage HLC values manually — OKDB handles them transparently.
