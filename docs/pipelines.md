# Pipelines

OKDB now has a base `pipelines` feature for storing environment-defined engine topologies in a synced `~pipelines` registry.

This is the generic layer above `engines`.

- engines remain standalone runtime units
- pipelines group engines structurally
- pipeline records live in the environment that defines them
- pipeline records sync like other env data

---

## V1 record shape

```javascript
{
    name: 'articles-ingest',
    template: null,
    status: 'active',   // 'active' | 'stopped'
    meta: { label: 'Articles ingest' },
    created: 1710000000000,
    updated: 1710000000000,
    engines: [
        { type: 'embedder',      name: 'shared-embedder',           role: 'embedder' },
        { type: 'indexer',       name: 'analytics:articles-ingest', role: 'indexer' },
        { type: 'vector-search', name: 'analytics:articles-ingest', role: 'search' },
    ],
}
```

Rules in V1:

- `name` is required and must be a non-empty string
- `template` must be `null`
- `status` must be `active` or `stopped`
- `engines` must be a non-empty ordered array
- every engine entry must have non-empty `type`, `name`, and `role`
- engine order is meaningful and preserved

---

## Where records live

Pipelines are environment-defined.

That means:

- `okdb.env('analytics').pipelines.create(...)` stores in `analytics` env `~pipelines`
- synced peers receive the record in that same env
- `okdb.pipelines.list()` aggregates pipeline records across opened envs

Unlike env-scoped engines, pipelines do **not** use `~system` by default.

---

## Current SDK surface

### Env-local facade

```javascript
const analytics = okdb.env('analytics');

// Engines must already exist before a V1 pipeline record can be created.
await analytics.pipelines.create({
    name: 'articles-ingest',
    template: null,
    status: 'active',
    meta: {},
    engines: [
        { type: 'embedder', name: 'shared-embedder', role: 'embedder' },
        { type: 'indexer', name: 'analytics:articles-ingest', role: 'indexer' },
    ],
});

const record = await analytics.pipelines.get('articles-ingest');
const all = await analytics.pipelines.list();

await analytics.pipelines.stop('articles-ingest');
await analytics.pipelines.start('articles-ingest');
await analytics.pipelines.restart('articles-ingest'); // stop + start
await analytics.pipelines.update('articles-ingest', { meta: { label: 'Ingest' } }); // meta/status only
await analytics.pipelines.rebuild('articles-ingest'); // member engines with api.rebuild(), in order
await analytics.pipelines.replaceMember('articles-ingest', 'embedder', 'other-embedder'); // same-role swap
await analytics.pipelines.remove('articles-ingest');
```

**Pipelines are structurally atomic — the pipeline is the engine.** Member topology (the set/order of roles) is immutable — `update()` refuses `engines` changes — and members cannot be added or removed at runtime; new arrangements of engines are new pipeline _types_ (templates / `createPipeline` families), not record surgery. Public engine lifecycle surfaces enforce this: `DELETE`/`stop`/`start`/`restart` on an engine that is a pipeline member is refused with `ENGINE_MANAGED_BY_PIPELINE` (HTTP 409) pointing at the owning pipeline — operate on the pipeline instead. Per-member config patches and diagnostics (pause/resume/retry, reset-cursor, index reload) remain available.

`replaceMember()` is the supported _parameter_ mutation: it swaps one member for another **existing engine of the same type**, re-points sibling members whose `config.<role>` referenced the old name (the indexer's and search engine's `embedder` field), restarts them, and rewrites the record. It does not re-embed — follow with `rebuild()` (UI: "Re-embed all") when the new member produces different output. `remove()` deletes env-owned members unless another pipeline record in the env still references them.

### HTTP API surface

The generic pipeline registry is also exposed over HTTP:

```text
GET    /api/pipelines/templates
GET    /api/pipelines/templates/:template
POST   /api/pipelines/templates/:template/preview
GET    /api/pipelines
GET    /api/env/:env/pipelines
GET    /api/env/:env/pipelines/:pipeline
POST   /api/env/:env/pipelines
POST   /api/env/:env/pipelines/templates/:template/create
POST   /api/env/:env/pipelines/scaffold
POST   /api/env/:env/pipelines/:pipeline/start
POST   /api/env/:env/pipelines/:pipeline/stop
POST   /api/env/:env/pipelines/:pipeline/restart
POST   /api/env/:env/pipelines/:pipeline/rebuild
PATCH  /api/env/:env/pipelines/:pipeline
POST   /api/env/:env/pipelines/:pipeline/replace-member
DELETE /api/env/:env/pipelines/:pipeline
```

- `GET /api/pipelines/templates` lists starter recommendations for both generic and embeddings pipeline families
- `GET /api/pipelines/templates/:template` returns one pipeline starter definition, including its input schema, defaults, `family`, and `recommended` flag
- `POST /api/pipelines/templates/:template/preview` expands a starter into the exact plan it would execute without persisting anything
- `POST /api/env/:env/pipelines/templates/:template/create` expands a starter template and executes the underlying scaffold/create operation
- `POST /api/env/:env/pipelines` expects referenced engines to already exist
- `POST /api/env/:env/pipelines/scaffold` is the convenience path that creates env-owned engines and then creates the pipeline record atomically
- `GET /api/pipelines` aggregates generic pipeline records across all currently opened environments

The pipeline template routes are a filtered view over the broader shared template registry exposed at `GET /api/engines/templates`:

- `/api/pipelines/templates` only returns entries with `kind: "pipeline"`
- generic starters currently include `generic-processor`, `generic-materializer`, and `generic-queue-worker`
- embeddings starters currently include `embeddings-inline-fake`, `embeddings-inline-ollama`, `embeddings-queue-fake`, and `embeddings-queue-ollama`

Template execution depends on the selected family:

- generic pipeline templates use the same atomic scaffold flow as `POST /api/env/:env/pipelines/scaffold`
- embeddings pipeline templates delegate to `okdb.embeddings.createPipeline(...)` and then return the resulting generic `~pipelines` record
- both flows stamp `meta.templateId` so the resulting record keeps template provenance

For embeddings-backed templates, remember that the persisted generic pipeline record name is the resolved `storage_key` (defaulting to the supplied pipeline `name`). The template response still returns the user-facing label through `meta.label`.

### MCP surface

The grouped `okdb_pipeline` tool intentionally separates the two pipeline families:

- generic pipeline registry actions are exposed as `generic_list_all`, `generic_list`, `generic_get`, `generic_create`, `generic_start`, `generic_stop`, `generic_delete`, and `generic_scaffold`
- embeddings env/type pipeline actions keep concise names such as `list`, `stats`, `query`, `start`, `stop`, and `delete`
- starter template actions are exposed as `template_list`, `template_get`, `template_preview`, and `template_create`

For MCP ergonomics, bare `list` also has a convenience fallback:

- `action: "list", env: "analytics", type: "articles"` → embeddings env/type pipeline summaries
- `action: "list", env: "analytics"` → the same env-scoped generic registry view as `generic_list`

In practice that means an MCP client can:

- call `template_list` to discover recommended starters
- call `template_preview` to inspect the concrete scaffold or embeddings-create plan
- call `template_create` to execute that plan in a target environment

Direct engine discovery/creation now lives in the dedicated `okdb_engine` tool instead:

- `action: "types"` lists registered engine kinds and their self-declared config metadata
- `action: "create"` creates a direct env-scoped engine without a pipeline record
- `action: "list" | "get" | "patch" | "delete" | "restart" | "pause" | "resume" | "retry" | "reset_cursor" | "rebuild"` manages existing direct engines

### Generic `queue-worker` engine

Step 04 adds a generic `queue-worker` engine type that can run standalone or participate as a reusable pipeline member.

In V1 it is:

- standalone-capable
- pipeline-compatible
- queue-backed
- function-driven

Typical flow:

```javascript
const analytics = okdb.env('analytics');

await analytics.functions.create({
    name: 'processArticleJob',
    source: `async (ctx) => {
        await ctx.env.ensureType('worker_results');
        await ctx.env.put('worker_results', String(ctx.payload.id), { ok: true });
        return { ok: true };
    }`,
});

await analytics.engines.createAndStartEngine('queue-worker', 'articles-worker', {
    job_type: 'article-ingest',
    handler: { kind: 'function', name: 'processArticleJob' },
    pollInterval: 100,
    concurrency: 2,
});

await analytics.pipelines.create({
    name: 'articles-ingest',
    template: null,
    status: 'active',
    meta: { label: 'Articles ingest' },
    engines: [{ type: 'queue-worker', name: 'articles-worker', role: 'worker' }],
});

await analytics.queue.enqueue('article-ingest', { id: 'job-1' });
```

`queue-worker` config shape in V1:

```javascript
{
    job_type: 'article-ingest',
    queue_env: 'analytics', // optional, defaults to the engine owning env
    handler: {
        kind: 'function',
        name: 'processArticleJob',
        env: 'analytics',   // optional, defaults to the engine owning env
    },
    concurrency: 2,
    pollInterval: 100,
    ttl: 30000,
}
```

Config notes:

- `job_type` — queue job type to consume
- `handler.kind` — currently must be `"function"`
- `handler.name` — function to invoke for each claimed payload
- `queue_env` — optional env name for the queue source; defaults to the engine owning env
- `handler.env` — optional env name for the function registry; defaults to the engine owning env
- `concurrency`, `pollInterval`, `ttl` — forwarded to the underlying queue worker runtime

Each claimed payload's function runs in the executing node's local sandbox thread (lazy, idle-reaped); `concurrency` bounds in-flight invocations — there is no pool to configure.

Behavior:

- claims jobs through the normal queue feature
- invokes the configured env function once per claimed payload
- completes or fails jobs using the same queue semantics as other queue workers
- can read from one env's queue while resolving the handler function from another env

Runtime stats exposed through `engine.api.stats()` include:

- `processed`
- `failed`
- `running`
- resolved `queue_env`
- resolved handler metadata

Minimal pipeline membership example:

```javascript
await analytics.pipelines.create({
    name: 'articles-ingest',
    template: null,
    status: 'active',
    meta: { label: 'Articles ingest' },
    engines: [{ type: 'queue-worker', name: 'articles-worker', role: 'worker' }],
});
```

### Generic `processor` engine

Step 05 adds a generic `processor` engine type for change-log driven pipeline members.

In V1 it is:

- standalone-capable
- pipeline-compatible
- built on the existing processor feature
- function-driven
- suitable for projection, transformation, and queue fan-out workflows

Typical flow:

```javascript
const analytics = okdb.env('analytics');

await analytics.registerType('articles');

await analytics.functions.create({
    name: 'projectArticleChanges',
    source: `async (ctx) => {
        await ctx.env.ensureType('article_projection');
        for (const change of ctx.payload) {
            if (change.action === 'put') {
                await ctx.env.put('article_projection', change.key, {
                    title: change.value.title,
                    source_env: ctx.processor.sourceEnv,
                });
            }
        }
        return { processed: ctx.payload.length };
    }`,
});

await analytics.engines.createAndStartEngine('processor', 'article-projector', {
    source_type: 'articles',
    handler: { kind: 'function', name: 'projectArticleChanges' },
    bootstrap: 'log',
    batchSize: 64,
});

await analytics.put('articles', 'a1', { title: 'Hello' });
```

`processor` config shape in V1:

```javascript
{
    source_type: 'articles',
    source_env: 'analytics', // optional, defaults to the engine owning env
    handler: {
        kind: 'function',
        name: 'projectArticleChanges',
        env: 'analytics',   // optional, defaults to the engine owning env
    },
    mode: 'async',
    bootstrap: 'log',
    originMode: 'all',
    batchSize: 64,
    hydrateValues: true,
    cursorKey: 'processor@article-projector',
    lockMode: 'exclusive',
    failOnHandlerError: true,
    flushDebounce: 0,    // ms — trailing-edge debounce; 0 = immediate
    flushInterval: null, // ms — periodic poll interval; null = disabled
}
```

Config notes:

- `source_type` — type whose change log the processor consumes
- `handler.kind` — currently must be `"function"`
- `handler.name` — function to invoke for each delivered batch of changes
- `source_env` — optional env name for the source type; defaults to the engine owning env
- `handler.env` — optional env name for the function registry; defaults to the engine owning env
- `mode`, `bootstrap`, `originMode`, `batchSize`, `hydrateValues`, `cursorKey`, `lockMode`, `flushDebounce`, `flushInterval` — forwarded to the underlying processor runtime
- `failOnHandlerError` — included in runtime metadata; V1 engine behavior treats handler failures as engine errors
- `flushDebounce` — coalesces rapid write bursts into a single handler delivery after the quiet period
- `flushInterval` — periodic poll; useful for `originMode: 'remote'` subscriptions where local writes don't trigger delivery
- When `originMode: 'all'` or `'remote'`, the underlying processor automatically subscribes to `EVENTS.SYSTEM_POKE` for cross-process change notification. No additional configuration is needed for correct multi-process behavior.

Behavior:

- consumes change-log batches through the normal processor feature
- invokes the configured env function with `ctx.payload` = `changes[]` (the batch array) and `ctx.processor` containing trigger metadata (`mode`, `sourceType`, `sourceEnv`, `processor`, `engineKey`, `cursorKey`)
- exposes processor cursor / progress / lag / error state through the engine runtime API
- can read from one env's type log while resolving the handler function from another env

Runtime stats exposed through `engine.api.stats()` / `engine.api.status()` include:

- `source_type`
- resolved `source_env`
- resolved handler metadata
- `state`
- `lastClock`
- `headClock`
- `lag`
- `progress`
- `processedChanges`
- `failedBatches`

Minimal pipeline membership example:

```javascript
await analytics.pipelines.create({
    name: 'projection-pipeline',
    template: null,
    status: 'active',
    meta: { label: 'Projection pipeline' },
    engines: [{ type: 'processor', name: 'article-projector', role: 'processor' }],
});
```

### `materializer` engine

Step 10 adds a `materializer` engine type for deterministic source→target collection projection.

Unlike the generic `processor`, a materializer has an **explicit target type** and a **return-ops contract** that enables safe rebuild.

> **Views vs materializers** — if you need live aggregates (counts, sums, averages, grouped statistics) choose [views](./views.md): define a `reduce` spec and read the result synchronously via `env.views.get()`. If you need a _derived collection_ — one document per source document, with custom field mapping — use a materializer: the function returns ops that the engine applies to the target type, which is then queryable like any other type.

Key differences from `processor`:

| Concern           | `processor`             | `materializer`                        |
| ----------------- | ----------------------- | ------------------------------------- |
| Target            | implicit (side effects) | explicit (declared in config)         |
| Rebuild           | not safely possible     | first-class `rebuild()` operation     |
| Function contract | writes via `ctx.env`    | returns ops array for engine to apply |
| Target ownership  | unknown                 | engine owns the target lifecycle      |

Typical flow:

```javascript
const analytics = await db.createEnvironment('analytics');
await analytics.registerType('orders');

await analytics.functions.create({
    name: 'projectOrders',
    source: `async (ctx) => {
        // ctx.payload       = changes[]
        // ctx.materializer  = { sourceType, targetType, sourceEnv, targetEnv, mode, ... }
        const ops = [];
        for (const change of ctx.payload) {
            if (change.action === 'put') {
                ops.push({
                    action: 'put',
                    key:    change.key,
                    value:  { total: change.value.total, customerId: change.value.customerId },
                });
            }
            if (change.action === 'remove') {
                ops.push({ action: 'remove', key: change.key });
            }
        }
        return ops;   // engine applies these to target_type
    }`,
});

const engine = await analytics.engines.createAndStartEngine('materializer', 'order-summary', {
    source_type: 'orders',
    target_type: 'order_summaries',
    handler: { kind: 'function', name: 'projectOrders' },
    bootstrap: 'snapshot',
    batchSize: 128,
});

await analytics.put('orders', 'o1', { total: 99.5, customerId: 'c1' });
// → order_summaries/o1 is written automatically by the engine

// Re-materialize from scratch:
await engine.api.rebuild();
```

`materializer` config shape:

```javascript
{
    source_type:          'orders',
    target_type:          'order_summaries',
    source_env:           'analytics',  // optional, defaults to engine env
    target_env:           'analytics',  // optional, defaults to engine env
    bootstrap:            'snapshot',   // 'snapshot' | 'log'
    originMode:           'all',
    batchSize:            128,
    clearTargetOnRebuild: true,         // whether rebuild truncates target first
    handler: {
        kind:        'function',
        name:        'projectOrders',
        env:         'analytics',       // optional, defaults to engine env
        recordRuns:  'errors',
    },
}
```

Config notes:

- `source_type` — type whose change log the materializer consumes
- `target_type` — type the engine writes to (created automatically if absent)
- `handler.kind` — currently must be `"function"`
- `handler.name` — function invoked for each batch; must return an ops array
- `source_env` / `target_env` — optional env overrides
- `clearTargetOnRebuild` — whether `rebuild()` truncates the target before replaying (default: `true`)
- `bootstrap`, `originMode`, `batchSize` — forwarded to the underlying processor runtime

Function contract:

- **`ctx.payload`** = `changes[]` — batch of change records
    - `change.action` = `'put' | 'remove'`
    - `change.key` = source key
    - `change.value` = hydrated source document for puts
    - `change.clock` = live log clock, or `null` during snapshot bootstrap
- **`ctx.materializer`** = trigger metadata (`sourceType`, `targetType`, `sourceEnv`, `targetEnv`, `mode`, `engineKey`, `cursorKey`)
- **Return value** = `ops[]` — array of `{ action: 'put'|'remove', key, value? }` objects
- The function must **not** write directly via `ctx.env` — the engine applies the returned ops

`ctx.materializer.mode` is:

- `'build'` during bootstrap / replay
- `'live'` during normal ongoing consumption

Engine API:

- `engine.api.stats()` / `engine.api.status()` — state, lag, processedChanges, appliedOps, targetCount
- `engine.api.rebuild()` — stop, clear target (if configured), reset cursor, replay from origin
- `engine.api.resetCursor()` — reset cursor only without clearing target
- `engine.api.pause()` / `engine.api.resume()` — pause/resume consumption
- `engine.api.retry()` — retry after error state

```javascript
const all = await okdb.pipelines.list();
const analyticsOnly = await okdb.pipelines.list({ envName: 'analytics' });
const record = await okdb.pipelines.get('analytics', 'articles-ingest');
```

---

## Lifecycle behavior in V1

The base feature is intentionally narrow.

Allowed updates:

- `status`
- `meta`

Supported lifecycle operations:

- `create`
- `get`
- `list`
- `update` (`meta` / `status` only)
- `start`
- `stop`
- `remove`

Topology is structurally immutable in V1:

- changing engine membership is rejected
- changing engine roles is rejected
- changing engine order is rejected

### Aggregate health

Aggregate health is derived at runtime from persisted pipeline `status` and current member engine state:

- pipeline `status === 'stopped'` → health `stopped`
- all members online → health `online`
- no members online and all are `error` / `stopped` / `missing` → health `error`
- otherwise → health `degraded`

### Safe delete behavior

`remove()` deletes the pipeline record and uninstalls engines owned by the same env.

Shared/global engines are preserved.

### HTTP routes

Generic pipelines now expose env-scoped routes:

- `GET /api/env/:env/pipelines`
- `GET /api/env/:env/pipelines/:pipeline`
- `POST /api/env/:env/pipelines`
- `POST /api/env/:env/pipelines/:pipeline/start`
- `POST /api/env/:env/pipelines/:pipeline/stop`
- `DELETE /api/env/:env/pipelines/:pipeline`

Read responses include derived pipeline/member inspection data such as:

- pipeline `health`
- ordered member `engines`
- per-member `role`, `type`, `name`
- per-member `state`, `status`, `isRunning`, `owned`, `storeEnv`
- engine `key`, `config`, and `meta` when the referenced engine exists
- runtime cursor / lag / progress / error fields when the member exposes them

### Admin visibility

The admin UI now exposes pipelines and engines through three complementary views:

- **Queue → Workers** — create and manage `queue-worker` engines directly for the selected job type
- **DB → Type detail** — open a type-scoped engines view for embeddings/vector pipelines, including shortcuts from the vector/index drill-ins back to the owning pipeline
- **Engines** — the primary env-scoped workspace for cross-type inspection, with filters for mode, pipeline family, engine type, status, search text, and source type

Current behavior:

- all engine CRUD and inspection still resolves through env-scoped APIs such as `/api/env/:env/engines`
- type-local pipeline views stay constrained to the selected env + source type
- embedding indexer/search panels can jump back to the owning pipeline record
- queue-worker creation is already direct from the Queue section
- type-scoped DB views now open the same shared create wizard in a modal, with the env + source type pre-scoped and the source type locked to the current DB context
- that type-scoped modal supports `processor`, `materializer`, and `embedding`; `queue-worker` creation stays direct from the Queue section
- the global Engines create flow still supports `processor`, `materializer`, `queue-worker`, and `embedding` from one place

### Sync / runtime activation

Synced pipeline declarations now reconcile through the same higher-level runtime activation seam used for synced engines.

That shared activation path runs:

- after `OKDB.open()` startup restore
- after each sync reconcile pass completes

Behavior in V1:

- env-scoped engine records still restore/start through the engine feature
- pipeline records add a second reconciliation pass based on persisted pipeline `status`
- `status: 'active'` attempts to bring all present members online in declaration order
- `status: 'stopped'` ensures running members are stopped in reverse order
- if a synced pipeline arrives before all referenced engine records exist locally, activation is skipped for that pass and retried on the next shared runtime activation cycle
- per-pipeline activation failures are logged and retried later; they do not abort the broader reconcile pass

Cluster expectation:

- sync replicates declarations (`~engines`, `~pipelines`, env records)
- local nodes then reconcile those declarations into runtime state
- structural completeness is still required for a pipeline to become fully active

---

## Relation to embeddings

Embeddings now use this generic pipeline model as their persisted grouping layer while keeping the richer `okdb.embeddings` facade.

Current behavior:

- `okdb.embeddings.createPipeline(...)` provisions the underlying engines **and** persists an env-local `~pipelines` record
- that record uses the pipeline `storage_key` as its generic name
- member roles are explicit and ordered: `embedder`, `indexer`, optional `worker`, `search`
- the record is tagged with `meta.family = 'embeddings'` so specialized embeddings views can recognize it cleanly
- embeddings lifecycle routes now delegate to the generic pipeline feature when a generic record exists

Embeddings-backed records also use `meta.lifecycleSkipRoles = ['embedder']`.

That keeps shared embedders out of per-pipeline stop/start behavior while still allowing generic pipeline operations to manage env-owned members such as the indexer, search engine, and optional queue worker.

This makes embeddings the first built-in feature validated on top of the generic pipeline record model rather than only name-based engine grouping.
