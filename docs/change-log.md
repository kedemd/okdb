# Change Log & Events

Every write in OKDB — put, remove, registerType, registerIndex — increments a monotonic integer **clock** and appends an entry to the change log. This is the backbone of sync, the processor system, and reactive change handling.

---

## The clock

A per-environment monotonic integer. Starts at 0, increments by 1 on every write transaction.

```javascript
// Current clock value
const clock = okdb.getClock();

// Per-type clock (highest clock seen for that type)
const usersClock = okdb.getClock('users');
```

---

## Reading the change log

```javascript
// Get changes between clock 100 and 200 (both inclusive)
const changes = okdb.getChanges(null, 100, 200);
for (const change of changes) {
    console.log(change);
    // {
    //   clock:     142,
    //   id:        'item:users@alice',
    //   type:      'users',
    //   key:       'alice',
    //   action:    'put',           // 'put' | 'remove' | 'type_register' | 'type_drop' | 'index_register' | 'index_drop'
    //   timestamp: 1709900000000,  // HLC value (wall-clock ms + logical counter)
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
okdb.events.on('item:create', ({ type, key, value, clock, origin }) => {
    console.log(`Created ${type}/${key}`);
});

okdb.events.on('item:update', ({ type, key, value, oldValue, clock }) => {
    console.log(`Updated ${type}/${key}`);
});

okdb.events.on('item:remove', ({ type, key, oldValue, clock }) => {
    console.log(`Removed ${type}/${key}`);
});
```

### System events

```javascript
okdb.events.on('system:clock_change', ({ clock, type }) => { ... });
okdb.events.on('system:clock_change@users', ({ clock }) => { ... }); // type-specific
okdb.events.on('system:ready', (okdb) => { ... });
okdb.events.on('system:stopped', () => { ... });
okdb.events.on('env:opened', ({ name }) => { ... });
```

Events fire **after** the LMDB transaction is durably committed. Listeners never see speculative data.

:::warning Backpressure
Events are emitted synchronously via `EventEmitter`. A slow listener blocks subsequent event delivery. For heavy processing, use the **Processor** system instead.
:::

---

## Processor

The Processor is OKDB's reactive change handler — a composable, configurable, inline-or-queue mechanism for reacting to type mutations.

Think of it as event listeners with superpowers: they can filter by origin, run inline or async, and are managed as named, stoppable handlers.

### Registering a handler

```javascript
const stop = okdb.env('default').processor.register('orders', {
    name: 'orders:fulfillment', // human-readable name
    mode: 'inline', // 'inline' = synchronous, post-commit
    originMode: 'all', // 'all' | 'local' | 'remote'

    handler(changes) {
        for (const ch of changes) {
            if (ch.action !== 'put') continue;
            if (ch.newValue.status === 'paid') {
                scheduleShipment(ch.key, ch.newValue);
            }
        }
    },
});

// Stop the handler
stop();
```

### Register options reference

| Option               | Type       | Default    | Description                                                                                                                                                                                                                                   |
| -------------------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handler`            | `function` | required   | Async callback receiving `(changes[], info)`                                                                                                                                                                                                  |
| `mode`               | `string`   | `'fanout'` | `'fanout'` (N-of-N) \| `'single'` (1-of-N) \| `'inline'` (every writer). Old names `'async'`→`'fanout'` and `'worker'`→`'single'` are accepted as deprecated aliases.                                                                         |
| `bootstrap`          | `string`   | `'log'`    | `'snapshot'` \| `'log'` — how the initial backfill runs                                                                                                                                                                                       |
| `originMode`         | `string`   | `'self'`   | `'all'` \| `'self'` \| `'remote'`                                                                                                                                                                                                             |
| `batchSize`          | `number`   | `256`      | Max changes delivered per handler call                                                                                                                                                                                                        |
| `hydrateValues`      | `boolean`  | `true`     | Attach current document value to each change                                                                                                                                                                                                  |
| `cursorKey`          | `string`   | `null`     | Persist the cursor under this key so progress survives restarts                                                                                                                                                                               |
| `lockMode`           | `string`   | `null`     | `'exclusive'` — serialise concurrent flushes for this processor                                                                                                                                                                               |
| `failOnHandlerError` | `boolean`  | `false`    | Put the processor into error state on handler exception                                                                                                                                                                                       |
| `flushDebounce`      | `number`   | `0`        | Trailing-edge debounce in ms. Rapid write bursts coalesce into a single flush after `flushDebounce` ms of quiet. `0` = flush immediately (default).                                                                                           |
| `flushInterval`      | `number`   | `null`     | Start a `setInterval` that ticks `_scheduleFlush` every `flushInterval` ms after bootstrap. Useful for polling-style processors or `originMode: 'remote'` subscriptions where local writes don't trigger `_onAfterCommit`. `null` = disabled. |
| `name`               | `string`   | `null`     | Human-readable label shown in admin UI and status                                                                                                                                                                                             |
| `meta`               | `object`   | `{}`       | Arbitrary metadata attached to status objects                                                                                                                                                                                                 |
| `leaseTtlMs`         | `number`   | `30000`    | Lease TTL for cross-process exclusive execution                                                                                                                                                                                               |

`stop.status()` (alias `stop.getStatus()`) returns the live processor state including `flushDebounce` and `flushInterval`. `stop.pause()` clears both timers; `stop.resume()` restarts the interval if configured.

### Change object shape

```javascript
{
    type:     'orders',
    key:      'o42',
    action:   'put',          // 'put' | 'remove'
    oldValue: { ... },        // previous value (null if new)
    newValue: { ... },        // new value (null if removed)
    clock:    182,
    origin:   'node-uuid',
    txnId:    'txn-uuid',
}
```

### originMode

| Value      | Fires when                           |
| ---------- | ------------------------------------ |
| `'all'`    | Any write, local or synced           |
| `'local'`  | Only writes originating on this node |
| `'remote'` | Only writes arriving via sync        |

This is useful for reacting differently to local vs. replicated changes — e.g., sending a notification only when your own node creates a record, not when it receives one from a peer.

**Multi-process deployments:** Async and worker processors with `originMode: 'all'` or `'remote'` automatically subscribe to `EVENTS.SYSTEM_POKE` — the UDP bus's cross-process commit signal. When another process writes to the same LMDB environment, it sends a `POKE` via the bus; the local process receives it and wakes all eligible processors within tens of milliseconds. No configuration is needed — the behavior is automatic based on `originMode`. Processors with `originMode: 'self'` do not subscribe (they explicitly don't care about remote-origin changes).

### Processor on a custom env

Each environment has its own processor:

```javascript
const env = okdb.env('analytics');
const stop = env.processor.register('events', {
    mode: 'inline',
    originMode: 'all',
    name: 'analytics:aggregate',
    handler(changes) {
        /* ... */
    },
});
```

---

## HLC timestamps

The `timestamp` field on change objects is a **Hybrid Logical Clock** value: a 64-bit integer encoding both wall-clock milliseconds and a logical counter. HLC values are monotonically increasing even when system clocks skew backwards, which makes them safe for LWW conflict resolution in sync.

```javascript
// Decode an HLC value
const { OKDBHlc } = require('okdb/okdb-hlc');
const { wallMs, logical } = OKDBHlc.decode(change.timestamp);
```

You don't need to manage HLC values manually — OKDB handles them transparently.
