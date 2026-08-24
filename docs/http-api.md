# HTTP API

OKDB includes a built-in HTTP server with a REST API, sync endpoint, and admin UI. It can run as a standalone server **or** be integrated into an existing Express, Fastify, or raw Node.js server — your choice.

## Generic pipelines

The generic `pipelines` feature exposes env-scoped CRUD and inspection routes:

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
DELETE /api/env/:env/pipelines/:pipeline
```

Pipeline create requests must reference engines that already exist.
`POST /api/env/:env/pipelines/scaffold` is the atomic convenience variant: it creates one or more env-owned engines and then persists the pipeline record, cleaning up already-created engines if later validation fails.
`GET /api/pipelines/templates` is the pipeline-only filtered view of the shared template registry; it returns starter plans whose `kind` is `pipeline`.
`POST /api/pipelines/templates/:template/preview` expands one of those starters into the concrete create payload it would execute.
`POST /api/env/:env/pipelines/templates/:template/create` executes that plan in the target environment.
`GET /api/pipelines` aggregates generic pipeline records across all opened environments.
Pipeline reads include derived aggregate health and member engine runtime state.
In the admin API explorer these routes are grouped under the `pipelines` tag.

Typical pipeline read responses include:

- pipeline `status` and derived `health`
- ordered member `engines`
- per-member `role`, `type`, `name`, `state`, `status`, `isRunning`
- ownership/runtime hints such as `owned`, `storeEnv`, `lag`, `progress`, `cursorKey`, and `error`

Embeddings-specific env/type pipeline routes are now layered on top of this same generic model when a matching generic pipeline record exists.

In practice that means:

- `POST /api/env/:env/type/:type/pipelines` creates the embeddings engines and the env-local generic pipeline record
- `GET /api/env/:env/type/:type/pipelines` prefers generic pipeline-backed summaries and only falls back to legacy engine grouping for older pipelines
- specialized lifecycle routes such as `.../start`, `.../stop`, and `DELETE .../:pipeline` delegate to the generic pipeline feature when possible
- shared embedder members remain preserved during embeddings pipeline stop/delete behavior

---

## Starting the server

```javascript
okdb.http.listen(8080);
// or with a host:
okdb.http.listen(8080, '0.0.0.0');
```

The HTTP server is optional. You can use OKDB entirely in-process without it.

---

## Authentication

### Bearer token

```javascript
const okdb = new OKDB('./db', {
    api: { tokens: ['my-secret-token'] },
});
```

```bash
curl http://localhost:8080/api/type/users \
  -H "Authorization: Bearer my-secret-token"
```

### Basic auth (admin UI)

```javascript
admin: {
    auth: {
        user:         'admin',
        pass:         'secret',
        cookieSecret: 'change-me-in-production',
        cookieTtlMs:  3_600_000,
    },
}
```

---

## Operations metadata model

OKDB's HTTP layer is also the current **operations registry** for the project.

Routes can now carry canonical operation metadata that powers:

- `/api/docs`
- shell help and route listing
- MCP `tools/list` and `tools/call`
- future admin/docs consumers

### Canonical metadata fields

Representative fields include:

- `id` — stable operation identifier
- `summary`
- `description`
- `tags`
- `inputSchema`
- `outputSchema`
- `safety`
- `access`
- `http`
- `cli`
- `mcp`

### Example

```javascript
http.add('GET', '/api/info', () => ({ result: okdb.info }), {
    id: 'system_info',
    summary: 'Database info',
    tags: ['system'],
    inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
    },
    outputSchema: {
        type: 'object',
        additionalProperties: true,
    },
    safety: {
        access: 'read',
        destructive: false,
        idempotent: true,
        longRunning: false,
        streaming: false,
    },
    access: {
        audiences: ['http', 'shell', 'mcp'],
        authRequired: true,
        internalOnly: false,
    },
    http: {
        bodyMode: 'none',
    },
    mcp: {
        include: true,
        tool: 'system_info',
        readOnlyHint: true,
    },
});
```

### Path/query/body projection rules

OKDB uses a canonical logical input model and projects it into HTTP as follows:

1. **Path params are inferred** from the route path (including optional env defaults)
2. **Query params are declared explicitly** via `http.querySchema`
3. **Remaining logical input fields** go to the body by default
4. **Explicit `http.bindings`** are only needed for ambiguous or nonstandard cases

### `http.bodyMode`

Supported body projection modes include:

- `none`
- `remaining-fields`
- `object`
- `payload-or-self`
- `array`
- `raw`

### Validation rules

Canonical operation metadata is validated for:

- missing bindings
- ambiguous bindings
- illegal bindings
- raw/MCP transport incompatibilities

During migration, strict validation applies to canonical routes while legacy routes still pass through until converted.

---

## `/api/docs`

`GET /api/docs` still returns the route registry shape used by existing consumers, but entries now also include normalized operation metadata where available.

Each entry contains at least:

- `method`
- `path`
- `defaults`
- `meta`
- `operation`

The legacy `meta` shape remains present during migration for compatibility.

---

## MCP generation

OKDB's MCP surface now derives tools primarily from route operation metadata.

Routes may opt into MCP with metadata like:

```javascript
mcp: {
  capability: 'queue',
  action: 'queue_list_jobs',
  readOnlyHint: true,
}
```

Most routes are exposed through grouped capability tools such as `okdb_queue`, `okdb_function_run`, and `okdb_index`.
Those tools do **not** use dotted method names like `okdb_function_run.preview`.
Instead, the tool name stays fixed and the requested operation is supplied as an `action` argument.

Examples:

```json
{
    "name": "okdb_function_run",
    "arguments": { "action": "preview", "env": "default", "source": "(ctx) => ({ ok: true })" }
}
```

```json
{
    "name": "okdb_index",
    "arguments": {
        "action": "create",
        "env": "default",
        "type": "places",
        "fields": ["location"],
        "indexType": "geo",
        "precision": 7
    }
}
```

Convenience MCP aliases:

- `fields: [...]` is joined into the canonical `index` id using `~`
- `indexType: "geo"` maps to the underlying index type hint
- env-scoped MCP calls must always send an explicit `env`

The MCP layer excludes non-tool transports by default, including:

- SSE/event stream routes
- raw upload routes
- streaming download/export routes
- hidden/internal transport routes

Generated MCP calls route through `okdb.http.handle(...)` rather than duplicating feature logic.

For the grouped `okdb_pipeline` tool:

- embeddings env/type pipeline actions keep concise names such as `list`, `stats`, `query`, `start`, and `delete`
- generic pipeline registry actions use the `generic_*` prefix (`generic_list`, `generic_get`, `generic_create`, `generic_start`, `generic_stop`, `generic_delete`, `generic_scaffold`) so they do not collide with embeddings actions
- as an MCP convenience, `action: "list"` falls back to env-scoped `generic_list` when `type` is omitted; include `type` to get the specialized embeddings env/type listing
- template discovery/execution is also available as `template_list`, `template_get`, `template_preview`, and `template_create`
- those template actions are pipeline-only and correspond to `/api/pipelines/templates...`, not the broader shared engine registry

For the grouped `okdb_engine` tool:

- `action: "types"` lists registered engine kinds and any self-declared config schemas/examples
- `action: "templates" | "template_get" | "template_preview"` exposes the shared starter registry, including both direct-engine templates and pipeline templates
- `action: "template_create"` creates a direct env-scoped engine from a starter template
- `action: "list" | "get" | "create" | "patch" | "delete" | "restart" | "pause" | "resume" | "retry" | "reset_cursor" | "rebuild"` targets direct env-scoped engine admin routes

For the grouped `okdb_embeddings` tool:

- create actions remain available (`embedder_create`, `indexer_create`, `search_create`, `worker_create`)
- discovery actions are also available (`providers`, `models`, `models_by_provider`, `algorithms`, `probe_ollama_models`, `embedder_models`) so MCP clients can inspect provider schemas and model catalogs before creating engines or pipelines

---

## Engine management endpoints

The direct `engines` feature exposes env-scoped inspection and admin routes:

```text
GET    /api/engines/types
GET    /api/engines/templates
GET    /api/engines/templates/:template
POST   /api/engines/templates/:template/preview
POST   /api/env/:env/engines/templates/:template/create
GET    /api/env/:env/engines?type=<engine-type>
POST   /api/env/:env/engines
GET    /api/env/:env/engines/:type/:name
PATCH  /api/env/:env/engines/:type/:name
DELETE /api/env/:env/engines/:type/:name
POST   /api/env/:env/engines/:type/:name/restart
POST   /api/env/:env/engines/:type/:name/pause
POST   /api/env/:env/engines/:type/:name/resume
POST   /api/env/:env/engines/:type/:name/retry
POST   /api/env/:env/engines/:type/:name/reset-cursor
POST   /api/env/:env/engines/:type/:name/rebuild
```

`GET /api/engines/types` returns the registered engine kinds plus any backend-supplied config schema, example config, patchability, creation notes, and matching starter `templateIds` / `recommendedTemplateIds`.
`GET /api/engines/templates` returns the full starter registry shared by direct engines and pipeline builders.
That means it includes both `kind: "engine"` and `kind: "pipeline"` entries, whereas `GET /api/pipelines/templates` exposes only the pipeline subset.
`POST /api/engines/templates/:template/preview` expands a starter template into the concrete create payload it would execute, without persisting anything.
`POST /api/env/:env/engines/templates/:template/create` only accepts templates whose plan kind is `engine`; pipeline templates must go through `/api/env/:env/pipelines/templates/:template/create`.
`GET /api/env/:env/engines` returns runtime summaries for engines stored in that environment. The optional `type` query parameter narrows results to one engine type.

MCP exposes these routes through `okdb_engine`, so clients can discover engine types and create/manage direct engines without going through a pipeline.

---

## Contributor guidance for new routes

When adding a new route in any `*-http.js` file:

1. provide a stable `id`
2. add `summary`, `description`, and `tags`
3. define `inputSchema`
4. define `outputSchema` where practical
5. classify `safety` and `access`
6. set `http.bodyMode` and `http.querySchema` as needed
7. decide whether the route should participate in MCP via `mcp.include`
8. avoid exposing raw/SSE/stream routes to MCP unless you add a deliberate adapter

Feature authors should keep the route's owning feature responsible for its metadata. Do not create a second disconnected metadata source for MCP or CLI.

---

## CRUD endpoints

All routes are under `/api`. The `:env` prefix is `default` unless you specify another environment.

### Records

```http
GET    /api/:env/type/:type/item/:key    → single record
PUT    /api/:env/type/:type/item/:key    → upsert (body.value = value)
PATCH  /api/:env/type/:type/item/:key    → partial update (body.patch = patch doc)
DELETE /api/:env/type/:type/item/:key    → remove
POST   /api/:env/type/:type/query        → query records
POST   /api/:env/transaction             → atomic batch writes
```

**Atomic bulk writes:** `POST /api/:env/transaction` accepts an array of `put`, `update`, `patch`, and `remove` operations and commits them all in one LMDB transaction — the right primitive for bulk ingest. See [Transactions](./transactions.md#http-api--bulk-writes) for the full body format and examples.

**Hybrid search:** The `options` body field now accepts `fts` and `vector` sub-objects alongside `index`. See the querying guide for full documentation. When `fts` or `vector` is provided, the route automatically awaits the async result.

```bash
# Get a record
curl http://localhost:8080/api/default/type/users/item/alice \
  -H "Authorization: Bearer token"

# Upsert by key
curl -X PUT http://localhost:8080/api/default/type/users/item/alice \
  -H "Authorization: Bearer token" \
  -H "Content-Type: application/json" \
  -d '{"value": {"name": "Alice", "role": "superadmin"}}'

# Patch an existing record
curl -X PATCH http://localhost:8080/api/default/type/users/item/alice \
  -H "Authorization: Bearer token" \
  -H "Content-Type: application/json" \
  -d '{"patch":{"set":{"role":"admin"},"inc":{"loginCount":1},"append":{"tags":["vip"]},"pull":{"tags":["trial"]}},"ifVersion":7}'

# Delete
curl -X DELETE http://localhost:8080/api/default/type/users/item/alice \
  -H "Authorization: Bearer token"
```

### Patch document format

`PATCH` uses a structured patch document.

- `set` — assign or replace fields/paths
- `unset` — remove fields/paths
- `inc` — increment numeric fields
- `merge` — deep-merge object subtrees
- `append` — append one or more values to arrays
- `pull` — remove matching values from arrays

```json
{
    "patch": {
        "set": { "status": "active" },
        "inc": { "metrics.views": 1 },
        "merge": { "profile": { "theme": "dark" } },
        "append": { "tags": ["featured"] },
        "pull": { "tags": ["draft"] }
    }
}
```

Notes:

- patch applies to existing object records only
- arrays are incrementally mutated via `append` and `pull`
- `ifVersion` enables compare-and-swap writes
- successful patch calls return `204 No Content`

### List records

```http
GET /api/:env/type/:type
  ?limit=50
  &offset=0
  &start=<key>
  &end=<key>
  &reverse=false
```

```bash
curl "http://localhost:8080/api/default/type/users?limit=10&reverse=true" \
  -H "Authorization: Bearer token"
```

---

## Change log endpoints

```http
GET /api/:env/changelog
  ?before=<clock>    → changes up to this clock (inclusive)
  ?after=<clock>     → changes from this clock onwards
  ?type=<typename>   → filter by type

GET /api/:env/type/:type/changelog
  ?before=<clock>
  ?after=<clock>
```

```bash
# Get changes since clock 100
curl "http://localhost:8080/api/default/changelog?after=100" \
  -H "Authorization: Bearer token"
```

---

## Schema endpoints

```http
GET  /api/:env/types                    → list all registered types
POST /api/:env/types                    → register a type
DELETE /api/:env/type/:type             → drop a type

POST /api/:env/type/:type/indexes       → register an index
DELETE /api/:env/type/:type/index/:idx  → drop an index
GET  /api/:env/type/:type/index/:idx/count?start=<json>&end=<json>  → count index entries in range
```

---

## Full-text search endpoints

```http
GET    /api/:env/fts/size                          → FTS storage summary for the env
GET    /api/:env/type/:type/fts                    → list FTS indexes
POST   /api/:env/type/:type/fts/:name              → register a new FTS index
DELETE /api/:env/type/:type/fts/:name              → drop an FTS index
POST   /api/:env/type/:type/fts/:name/reset        → rebuild an FTS index from scratch
POST   /api/:env/type/:type/fts/:name/search       → search an FTS index
POST   /api/:env/type/:type/fts/flush              → flush FTS processor (await catch-up)
```

### GET /api/:env/fts/size — env-level storage summary

Returns a single object summarizing FTS storage for the environment. Useful for "how much disk is FTS costing me" overviews and for spotting reclaimable slack.

| Field               | Type     | Description                                                                                  |
| ------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `diskBytes`         | `number` | Sum of `~fts/<env>/` + `~fts/<env>_docs/` data.mdb file sizes. LMDB high-water mark.         |
| `payloadBytes`      | `number` | Actual stored bytes (sum of all index payloads + shared dictionaries).                       |
| `indexPayloadBytes` | `number` | Payload attributable to indexes only (excludes shared dictionaries).                         |
| `sharedDictBytes`   | `number` | Bytes used by the env-shared docKey↔docId and token↔tokenId dictionaries.                    |
| `slackBytes`        | `number` | `diskBytes - payloadBytes`. Free LMDB pages — reclaimable by future writes or `env.compact`. |
| `indexes`           | `array`  | Per-index breakdown: `[{ type, name, sizeBytes }, ...]`.                                     |

### GET /api/:env/type/:type/fts — list response

Each entry in the returned array includes:

| Field            | Type                                                        | Description                                                                                                                           |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | `string`                                                    | Index name                                                                                                                            |
| `status`         | `'creating' \| 'resetting' \| 'ready' \| 'waiting' \| null` | Per-index lifecycle status                                                                                                            |
| `config`         | `object \| null`                                            | Index configuration as registered                                                                                                     |
| `created`        | `number \| null`                                            | HLC clock at registration time                                                                                                        |
| `updated`        | `number \| null`                                            | HLC clock at last config update                                                                                                       |
| `error`          | `object \| null`                                            | Last per-index error, if any                                                                                                          |
| `processorState` | `'building' \| 'online' \| 'error' \| 'waiting' \| null`    | State of the background FTS processor for this type. `null` if no processor is running.                                               |
| `lag`            | `number \| null`                                            | Number of writes the processor has not yet indexed. `0` = fully caught up. `null` if no processor.                                    |
| `sizeBytes`      | `number`                                                    | Approximate per-index payload (frozen blobs + live entries + forward index scoped by this `ftsId`). Excludes env-shared dictionaries. |

`processorState` and `lag` are per-type fields — they reflect the single background processor that drives all FTS indexes on a type and are identical on every entry of the same type.

### POST /api/:env/type/:type/fts/flush — flush processor

Waits for the background FTS processor to catch up to the current write position for this type, then runs the FTS compactor to roll live-tier entries into the compacted Roaring bitmap tier. Responds `204 No Content` when fully caught up. This is a no-op if no processor is running or if the processor is already caught up.

- **Permission:** `schema:read`
- **Idempotent:** yes
- **Long-running:** yes (blocks until processor catches up)

Use this after bulk writes when immediate search consistency is required:

```bash
# Bulk-import docs, then flush before querying
curl -X POST http://localhost:8080/api/default/transaction \
  -H "Authorization: Bearer token" \
  -d '[{ "action": "put", "type": "articles", "key": "a1", "value": { "body": "hello" } }]'

curl -X POST http://localhost:8080/api/default/type/articles/fts/flush \
  -H "Authorization: Bearer token"

# Now search is guaranteed up-to-date
curl -X POST http://localhost:8080/api/default/type/articles/fts/main/search \
  -H "Authorization: Bearer token" \
  -d '{ "query": "hello" }'
```

---

## System info

```http
GET /api/info
```

Returns node ID, version, clock, type stats, plugin list, and resolved LMDB options.

---

## Sync endpoint

```http
GET /api/sync/delta?from_clock=<N>
Authorization: Bearer <sync-token>
```

Used by peer nodes during reconciliation. Returns a JSON stream of change objects.

```http
POST /api/sync/join
Authorization: Bearer <sync-token>
Content-Type: application/json

{ "address": "http://peer.example.com:8080" }
```

---

## File endpoints

```http
POST   /api/files                → upload file (multipart or raw)
GET    /api/files/:id            → download file (streams blob bytes)
GET    /api/files/:id/meta       → metadata only (no body stream)
DELETE /api/files/:id            → remove file
GET    /api/files                → list file metadata
```

---

## Custom middleware

Add your own middleware before route handlers:

```javascript
okdb.http.use(async (req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    await next();
});
```

Register custom routes:

```javascript
okdb.http.add('GET', '/api/custom/health', () => ({
    result: { ok: true, clock: okdb.getClock() },
}));
```

---

## Integrating with an existing framework

OKDB's HTTP layer is **framework-agnostic**. `okdb.http.listen()` is entirely optional — if you already have an Express, Fastify, or raw Node.js server, you can hand requests to OKDB directly via `okdb.http.handle()`.

`handle(method, path, { body, query, headers }, context)` returns a promise that resolves to `{ status, headers, body }`. Wire that into your framework's response however you like.

### Express

```javascript
const express = require('express');
const OKDB = require('@kedem/okdb');

const app = express();
const okdb = new OKDB('./mydb');
await okdb.open();

// Mount all /api/* and /admin/* routes on the existing Express server
app.use(express.json());
app.use(async (req, res, next) => {
    const path = req.path;
    if (!path.startsWith('/api') && !path.startsWith('/admin') && !path.startsWith('/docs')) {
        return next();
    }

    const response = await okdb.http.handle(
        req.method,
        path,
        {
            body: req.body,
            query: req.query,
            headers: req.headers,
        },
        { req, res },
    );

    const { status = 200, headers = {}, body } = response;
    res.status(status);
    for (const [k, v] of Object.entries(headers)) res.set(k, v);

    if (body == null) return res.end();
    if (typeof body?.pipe === 'function') return body.pipe(res);
    if (Buffer.isBuffer(body)) return res.end(body);
    if (typeof body === 'object') return res.json(body);
    res.send(String(body));
});

app.listen(3000);
```

### Fastify

```javascript
const fastify = require('fastify')({ logger: false });
const OKDB = require('@kedem/okdb');

const okdb = new OKDB('./mydb');
await okdb.open();

fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
        done(null, JSON.parse(body));
    } catch (e) {
        done(e);
    }
});

fastify.all('/api/*', async (request, reply) => {
    const response = await okdb.http.handle(
        request.method,
        request.url.split('?')[0],
        {
            body: request.body,
            query: request.query,
            headers: request.headers,
        },
        { req: request.raw, res: reply.raw },
    );

    const { status = 200, headers = {}, body } = response;
    reply.status(status);
    for (const [k, v] of Object.entries(headers)) reply.header(k, v);

    if (body == null) return reply.send();
    if (typeof body?.pipe === 'function') return reply.send(body);
    return reply.send(body);
});

await fastify.listen({ port: 3000 });
```

### Raw Node.js `http`

```javascript
const http = require('http');
const OKDB = require('@kedem/okdb');

const okdb = new OKDB('./mydb');
await okdb.open();

const server = http.createServer(async (req, res) => {
    // Your own routes first
    if (req.url === '/health') {
        res.end('ok');
        return;
    }

    // Delegate everything else to OKDB
    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        body = await new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (c) => (data += c));
            req.on('end', () => {
                try {
                    resolve(data ? JSON.parse(data) : null);
                } catch (e) {
                    reject(e);
                }
            });
            req.on('error', reject);
        });
    }

    const url = new URL(req.url, 'http://localhost');
    const response = await okdb.http.handle(
        req.method,
        url.pathname,
        {
            body,
            query: Object.fromEntries(url.searchParams),
            headers: req.headers,
        },
        { req, res },
    );

    const { status = 200, headers = {}, body: resBody } = response;
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

    if (resBody == null) {
        res.end();
        return;
    }
    if (typeof resBody?.pipe === 'function') {
        resBody.pipe(res);
        return;
    }
    if (Buffer.isBuffer(resBody)) {
        res.end(resBody);
        return;
    }
    if (typeof resBody === 'object') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(resBody));
        return;
    }
    res.end(String(resBody));
});

server.listen(3000);
```

:::tip
When you bring your own server, don't call `okdb.http.listen()`. OKDB's routes and middleware are still fully functional — you're just providing the transport layer yourself.
:::

:::note
`okdb.http.handle()` still runs all registered middleware and guards. If you configure admin auth (`options.admin.auth`), the `/admin/*` guard still applies — the same cookie/Basic-Auth logic works regardless of which HTTP framework is in front.
:::

---

## Admin UI

When `admin.auth` is configured, the admin UI is available at:

```
http://localhost:8080/admin/index.html
```

It provides:

- Type and record browser
- Index management (create, drop, view status)
- Live changelog viewer
- Embeddings pipeline status
- Sync peer status
- System info
