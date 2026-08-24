# Logging

OKDB has a built-in structured logger available as `okdb.log`. Logs are emitted as plain objects and routed to any number of attached sinks. A console sink is attached by default.

---

## Entry Shape

Every log call produces an entry with this shape:

```js
{
  level:   'info' | 'warn' | 'error' | 'debug',
  msg:     string,           // human-readable message
  meta:    object,           // system identity set by child loggers
  context: any,              // user-provided call-site data (second arg)
  ts:      number            // Date.now()
}
```

`meta` contains machine-readable identity fields (feature, env name, function name, etc). `context` contains whatever you pass as the second argument to a log call — it is for human display only and not filtered on.

### Known `meta` Keys

| Key        | Who sets it                | Example values                                                 |
| ---------- | -------------------------- | -------------------------------------------------------------- |
| `feature`  | each feature child logger  | `'queue'`, `'auth'`, `'fts'`, `'sync'`, `'functions'`, `'env'` |
| `env`      | env logger, functions pool | `'demo-places'`                                                |
| `fn`       | functions pool (per run)   | `'myFunction'`                                                 |
| `runId`    | functions pool (per run)   | `'abc123'`                                                     |
| `runnerId` | functions pool (per run)   | `'fn-1'`                                                       |

---

## `okdb.log` — Basic Usage

```js
okdb.log.info('server started', { port: 3000 });
okdb.log.warn('slow query', { ms: 420, type: 'events' });
okdb.log.error('unexpected failure', { err: err.message });
okdb.log.debug('cache miss', { key });
```

---

## `okdb.log.child(meta)` — Scoped Loggers

`child(extraMeta)` returns a new logger instance that shares the same sinks but stamps every entry with additional `meta` fields. Use it to create feature or run-scoped loggers.

```js
// Feature logger — created once, reused for all calls
const authLog = okdb.log.child({ feature: 'auth' });
authLog.warn('invalid token');
// → { level: 'warn', msg: 'invalid token', meta: { feature: 'auth' }, context: undefined, ts }

// Per-environment logger
const envLog = okdb.log.child({ feature: 'env', env: 'demo-places' });
envLog.info('env opened');
// → { ..., meta: { feature: 'env', env: 'demo-places' }, ... }

// Run-scoped child — created per function invocation
const runLog = okdb.log.child({ feature: 'functions', env, fn, runId, runnerId });
runLog.info('function invoked');
runLog.info('result ready', { value: 42 });
// → { ..., meta: { feature: 'functions', env, fn, runId, runnerId }, context: { value: 42 }, ts }
```

`child()` does a shallow merge of meta fields. Child meta overrides parent meta for the same key. The returned logger shares the same sink set — attaching or detaching sinks on the root logger affects all children.

---

## Consuming Logs

### `okdb.log.attach(fn)` — Custom Sink

Attach a function to receive every log entry:

```js
okdb.log.attach((entry) => {
    // entry: { level, msg, meta, context, ts }
    myExternalLogger.log(entry);
});
```

To detach, call the returned function:

```js
const detach = okdb.log.attach(fn);
detach();
```

### `okdb.events.on('log', fn)` — Event Bus

Entries are also emitted on the OKDB event bus:

```js
okdb.events.on('log', (entry) => {
    console.log(entry.meta?.feature, entry.msg);
});
```

### `okdb.logs` — Ring Buffer

A circular buffer of recent log entries is available for inspection:

```js
okdb.logs; // array of recent entries, newest last
```

---

## `attachConsole()` — Console Output

`okdb.log.attachConsole()` adds a human-readable console sink. It is called automatically when OKDB starts in development mode.

Function-scoped logs (`meta.feature === 'functions'`) are suppressed from the console because they are stored in function run records and displayed in the Admin UI instead. All other features are printed.
