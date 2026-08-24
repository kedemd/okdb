# Custom Functions

OKDB custom functions let you store and execute JavaScript routines inside the database with a controlled runtime.

They are designed for:

- reusable env-local business logic
- cross-env orchestration (via `unsafe: true`)
- stable HTTP entry points
- MCP-accessible orchestration routines

Custom functions are **stored**, **versioned**, **validated**, **audited**, and executed in a per-process **sandbox thread**.

---

## Mental model

Functions run **inside OKDB** with direct access to a live database facade.

Recommended starting flow:

1. fetch a canonical starter with `okdb_function` `action: "get_template"`
2. use the required shape `async (ctx) => { ... }`
3. use `ctx.env` for normal env-scoped work
4. use `ctx.env.txn(...)` for batched writes such as seeding 1000 records
5. only enable `unsafe: true` when you intentionally need privileged cross-env access through `ctx.okdb`

For bulk inserts specifically, the `seed` template is the best starting point.

That means a function should **perform writes itself**:

```js
async (ctx) => {
    await ctx.env.put('products', 'p1', { name: 'Widget' });
    return { ok: true };
};
```

It should **not** return a description of work for OKDB to execute later.

This is **incorrect**:

```js
(ctx) => ({
    operations: [{ action: 'put', type: 'products', key: 'p1', value: { name: 'Widget' } }],
});
```

If you want batched atomic writes, use `txn(...)`:

```js
async (ctx) => {
    await ctx.env.txn((txn) => {
        txn.create('products', 'p1', { name: 'Widget' });
        txn.create('products', 'p2', { name: 'Gadget' });
    });
    return { inserted: 2 };
};
```

---

## Every function belongs to an environment

All functions live in an env (including those created via `db.functions` — those are stored in the `~system` env).

Every function receives `ctx.env` pointing to its home environment.

For cross-env or privileged operations, mark the function `unsafe: true` to additionally receive `ctx.okdb`.

Most function code should stay on `ctx.env`, not `ctx.okdb`.

---

## Script contract

Stored scripts must be a single function expression:

```js
(ctx) => {};
async (ctx) => {};
```

Do **not** destructure the argument like this:

```js
async ({ ctx }) => {};
```

The runtime passes a single argument named `ctx`, so the canonical shape is always `async (ctx) => { ... }`.

The runtime rejects scripts that use unsupported forms or forbidden symbols.

### Forbidden

The current runtime rejects references to:

- `require`
- `import`
- `console`
- `module`
- `exports`
- `process`
- `child_process`
- `worker_threads`

Use `ctx.log(...)` instead of `console`.

---

## Runtime model

A function runs on **the node it was asked on**, in that node's per-process **sandbox thread**:
a dedicated `worker_thread` with its own okdb instance, heap-capped from `runtime.memoryMb` via
`resourceLimits`, with `terminate()` as the timeout/wedge watchdog. One sandbox per node,
lazy-spawned and idle-reaped; invocations run concurrently in it, capped. Execution **never
blocks the caller's main loop** — untrusted user code always runs off-loop — and containment is
thread-level: a wedged function is `terminate()`d without taking the node's other work down.
This is what makes "run the function locally" safe, so it no longer needs a separate worker
process.

Sandbox concurrency is capped **per process** (`OKDB_FN_SANDBOX_CONCURRENCY`, default 4):
invocations beyond the cap queue at the claim layer. Host-level CPU budgeting is the operator's
job — size the number of okdb processes (and their sandbox caps) to the machine.

Two invocation modes:

- **Synchronous** (`functions.run()` / HTTP execution) — routed straight to the local sandbox,
  no `~fn:requests` round-trip, lowest latency.
- **Durable / run-eventually** (survive the caller, store the result) — a [queue](queue.md) job
  on a designated node. The `~fn:requests` / `~fn:responses` substrate is retained as the
  durable invocation mode (the UDP bus carries a wake hint so dispatch is ~ms).

Either way: scripts are validated and compile-checked before storage; timeouts terminate and
replace the executor; memory is capped; every run is written to a run ledger. This makes
functions suitable for operational entry points without paying spawn cost on every call.

> **Removed in 2.0:** the anonymous worker-population dispatch and the child-process **fork
> pool** (`OKDB_FN_LEGACY_POOL`). Functions execute in the asking node's local sandbox. See
> [Upgrading to 2.0](upgrade-2.0.md). If you don't want every HTTP node carrying a sandbox,
> designate which nodes serve functions — placement is yours.

---

## Available runtime context

Every function receives:

- `ctx.payload` — caller-supplied input
- `ctx.info` — run metadata (function name, env, version, scope, run ID)
- `ctx.signal` — AbortSignal for timeout handling
- `ctx.log` — structured logger (see [Logging](#logging))
- `ctx.env` — live facade for the function's environment
- `ctx.job` — queue job context _(only when triggered by a queue-worker engine)_
- `ctx.processor` — processor trigger context _(only when triggered by a processor engine)_
- `ctx.materializer` — materializer trigger context _(only when triggered by a materializer engine)_

### `ctx.job` (queue-worker engines only)

When a function is invoked by a queue-worker engine, `ctx.job` provides
the queue job metadata and helpers:

- `ctx.job.id` — the job ID
- `ctx.job.type` — the job type
- `ctx.job.tries` — current attempt number
- `ctx.job.created` — creation timestamp
- `ctx.job.tags` — job tags (array or null)
- `ctx.job.priority` — job priority
- `ctx.job.bucket` — token bucket ID (or null)
- `ctx.job.cron` — cron expression (or null)
- `ctx.job.heartbeat()` — keep the job alive (fire-and-forget)
- `ctx.job.markProgress(message)` — report progress (fire-and-forget)

`ctx.job` is `undefined` for functions triggered via HTTP, SDK, or processor engines.

### `ctx.processor` (processor engines only)

When a function is invoked by a processor engine, `ctx.payload` is the batch of
changes (an array of `{ key, value, action, clock }` objects) and `ctx.processor`
provides the trigger metadata:

- `ctx.processor.mode` — `"snapshot"` (initial backfill) or `"live"` (ongoing)
- `ctx.processor.sourceType` — the type whose change-log is being consumed
- `ctx.processor.sourceEnv` — the environment the source type lives in
- `ctx.processor.processor` — the processor registration ID
- `ctx.processor.engineKey` — the engine key
- `ctx.processor.cursorKey` — the cursor key used to track progress

`ctx.processor` is `undefined` for functions triggered via HTTP, SDK, or queue-worker engines.

Example:

```js
async (ctx) => {
    // ctx.payload = array of changes
    // ctx.processor = trigger metadata
    await ctx.env.ensureType('article_projection');
    for (const change of ctx.payload) {
        if (change.action === 'put') {
            await ctx.env.put('article_projection', change.key, {
                title: change.value.title,
                mode: ctx.processor.mode,
                sourceEnv: ctx.processor.sourceEnv,
            });
        }
    }
    return { processed: ctx.payload.length };
};
```

### `ctx.materializer` (materializer engines only)

When a function is invoked by a materializer engine, `ctx.payload` is the batch of
changes (same shape as processor) and `ctx.materializer` provides the trigger metadata.
The function must **return an ops array** — the engine applies those ops to the target type.
The function must **not** write directly via `ctx.env`.

- `ctx.materializer.mode` — `"build"` (backfill / replay) or `"live"` (ongoing consumption)
- `ctx.materializer.sourceType` — the source type being consumed
- `ctx.materializer.targetType` — the target type being maintained
- `ctx.materializer.sourceEnv` — the environment the source type lives in
- `ctx.materializer.targetEnv` — the environment the target type lives in
- `ctx.materializer.engineKey` — the engine key
- `ctx.materializer.cursorKey` — the cursor key used to track progress

`ctx.materializer` is `undefined` for functions triggered via HTTP, SDK, queue-worker, or processor engines.

The returned ops array shape:

```js
[
    { action: 'put',    key: 'some-key', value: { ... } },
    { action: 'remove', key: 'other-key' },
]
```

Example:

```js
async (ctx) => {
    // ctx.payload    = changes[]
    // ctx.materializer = trigger metadata
    const ops = [];
    for (const change of ctx.payload) {
        if (change.action === 'put') {
            const doc = change.value ?? change.newValue;
            if (!doc) continue;

            ops.push({
                action: 'put',
                key: change.key,
                value: {
                    total: doc.total,
                    customerId: doc.customerId,
                    updatedAt: Date.now(),
                    sourceEnv: ctx.materializer.sourceEnv,
                },
            });
        }
        if (change.action === 'remove') {
            ops.push({ action: 'remove', key: change.key });
        }
    }
    return ops;
};
```

Change record notes:

- `change.value` is the normalized source document for `put` changes and is the preferred field to read.
- During snapshot bootstrap, `change.clock` is `null` because there is no original changelog clock for the synthetic snapshot row.
- `change.newValue` / `change.oldValue` may still be present for low-level compatibility, but materializer functions should prefer `change.value`.

`ctx.env` exposes live env methods such as:

- CRUD: `put`, `update`, `patch`, `create`, `remove`, `get`, `query`, ...
- schema/index helpers: `registerType`, `ensureType`, `registerIndex`, ...
- `transaction(options)` — low-level transaction object
- `txn(workOrOps, options?)` — convenience write-focused transaction helper
- `queue` — queue feature for this env
- `files` — files feature for this env

Example:

```js
async (ctx) => {
    ctx.log('counting records', { env: ctx.env.name });
    return {
        env: ctx.env.name,
        count: ctx.env.getCount('events'),
    };
};
```

### `ctx.env.txn(...)`

`txn(...)` is a **write-batch helper**, not a full read-your-own-writes transaction view.

Preferred callback form:

```js
await ctx.env.txn((txn) => {
    txn.create('events', 'e1', { kind: 'view' });
    txn.create('events', 'e2', { kind: 'click' });
});
```

Also supported: ops arrays

```js
await ctx.env.txn([
    { action: 'create', type: 'events', key: 'e1', value: { kind: 'view' } },
    ['create', 'events', 'e2', { kind: 'click' }],
]);
```

The `txn` object intentionally exposes **write methods only**:

- `put`
- `update`
- `patch`
- `create`
- `remove`
- `commit`
- `rollback`

For advanced callers, `txn.read` / `txn.raw` expose the underlying transaction object,
including committed-state reads such as `get()` and `query()`.

Important: queued writes are **not** visible to `txn.read` reads before commit.
`txn(...)` guarantees atomic commit/rollback of writes, but it does **not** provide
an in-memory overlay or transactional read-your-own-writes view.

---

## Unsafe functions

By default a function can only access its own environment. Mark a function `unsafe: true` to additionally receive `ctx.okdb` — a privileged root facade. The name `unsafe` reflects the consequence: these functions can reach any env.

```js
await okdb.env('default').functions.create({
    name: 'copySummary',
    unsafe: true,
    source: `async (ctx) => {
    const src = ctx.okdb.env('default');
    const dst = ctx.okdb.env('analytics');
    const count = src.getCount('events');
    await dst.put('summaries', 'latest', { count });
    return { count };
  }`,
});
```

`ctx.okdb` exposes root-level `env(name)` and a root-scoped `txn(...)`:

```js
async (ctx) => {
    await ctx.okdb.txn([
        { action: 'create', type: 'users', key: 'u1', value: { name: 'Ada' } },
        { action: 'create', type: 'users', key: 'u2', value: { name: 'Grace' } },
    ]);
    return { count: ctx.okdb.getCount('users') };
};
```

Use `unsafe: true` only when cross-env access or root-level writes are genuinely required.

---

## Logging

Use `ctx.log(...)` for structured function logs. All log levels are available:

```js
(ctx) => {
    ctx.log('starting run', { function: ctx.info.functionName });
    ctx.log.info('doing work');
    ctx.log.warn('slow path');
    ctx.log.error('something broke', { err: err.message });
    return { ok: true };
};
```

Every entry emitted from a function is automatically stamped with run identity in the `meta` field:

| `meta` field    | Value                          |
| --------------- | ------------------------------ |
| `meta.feature`  | `'functions'`                  |
| `meta.env`      | The environment name           |
| `meta.fn`       | The function name              |
| `meta.runId`    | Unique ID for this invocation  |
| `meta.runnerId` | Worker slot ID (e.g. `'fn-1'`) |

The second argument to any log call becomes the `context` field in the log entry — this is the user-provided data visible in the Admin UI function log panel.

Function logs are suppressed from the console (they are stored in the run record and displayed in the Admin UI). See [Logging](logging.md) for the full entry shape and consumer APIs.

---

## JavaScript API

```js
const env = okdb.env('analytics');

await env.functions.create({
    name: 'countEvents',
    source: '(ctx) => ({ env: ctx.env.name, count: ctx.env.getCount("events") })',
});

const run = await env.functions.run('countEvents');
console.log(run.status, run.result.value);
```

For unsafe cross-env functions:

```js
await okdb.env('default').functions.create({
    name: 'crossEnvCount',
    unsafe: true,
    source: '(ctx) => ({ analytics: ctx.okdb.env("analytics").getCount("events") })',
});

const run = await okdb.env('default').functions.run('crossEnvCount');
console.log(run.result.value);
```

---

## HTTP API

All function routes are env-scoped. The `:env` parameter defaults to `default` when omitted.

- `GET /api[/env/:env]/functions`
- `POST /api[/env/:env]/functions`
- `GET /api[/env/:env]/functions/:name`
- `PUT /api[/env/:env]/functions/:name`
- `DELETE /api[/env/:env]/functions/:name`
- `POST /api[/env/:env]/functions/:name/run`
- `POST /api[/env/:env]/functions/preview`
- `GET /api[/env/:env]/functions/:name/runs`
- `GET /api[/env/:env]/functions/:name/runs/:runId`

### MCP note

Function execution is exposed via the grouped `okdb_function_run` MCP tool.
Use `action: "run"` for stored functions and `action: "preview"` for unsaved drafts.

Example preview call:

```json
{
    "name": "okdb_function_run",
    "arguments": {
        "action": "preview",
        "env": "default",
        "source": "(ctx) => ({ ok: true, env: ctx.env.name })",
        "payload": { "sample": true }
    }
}
```

There is no separate dotted MCP method such as `okdb_function_run.preview`.

Example — create an unsafe function and run it:

```http
POST /api/env/analytics/functions
Authorization: Bearer <token>
Content-Type: application/json

{
  "name": "syncSummary",
  "unsafe": true,
  "source": "(ctx) => ({ count: ctx.okdb.env('default').getCount('users') })"
}
```

```http
POST /api/env/analytics/functions/syncSummary/run
Authorization: Bearer <token>
Content-Type: application/json

{ "payload": { "sample": true } }
```

---

## Validation errors

Common error codes:

- `FUNCTION_SCRIPT_REQUIRED`
- `FUNCTION_SCRIPT_TOO_LARGE`
- `FUNCTION_SCRIPT_INVALID_SHAPE`
- `FUNCTION_SCRIPT_FORBIDDEN_SYMBOL`
- `FUNCTION_SCRIPT_COMPILE_FAILED`
- `FUNCTION_TIMEOUT`

---

## Current limitations

Current implementation intentionally does **not** yet include:

- precise per-script CPU quotas
- arbitrary module imports
- direct console access
- transactional read-your-own-writes overlays inside `txn(...)`
- admin UI for functions

---

## See also

- [HTTP API](./http-api.md)
- [Queue](./queue.md)
- [Files](./files.md)
- [Plugins](./plugins.md)
