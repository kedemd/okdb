<img src="https://raw.githubusercontent.com/kedemd/okdb/main/banner.jpg" alt="OKDB — Embedded-First · Sync-Native · AI-Ready" width="100%" />

<br/>

<p align="center">
  <a href="docs/getting-started.md"><strong>Getting Started</strong></a> ·
  <a href="docs/deployment.md">Roles & Deployment</a> ·
  <a href="docs/querying.md">Querying</a> ·
  <a href="docs/indexes.md">Indexes</a> ·
  <a href="docs/fts.md">Full-Text Search</a> ·
  <a href="docs/embeddings.md">Embeddings</a> ·
  <a href="docs/sync.md">Sync</a> ·
  <a href="docs/functions.md">Functions</a> ·
  <a href="docs/pipelines.md">Pipelines</a> ·
  <a href="docs/http-api.md">HTTP API</a>
</p>

---

**OKDB** is an embedded, document-centric database for Node.js. No separate server. No network hop. Open a path, write data.

It is built on [LMDB](https://www.symas.com/lmdb) — one of the fastest memory-mapped key-value stores ever built — and layers on top: typed collections, composite secondary indexes, full-text search, vector embeddings, multi-node sync, a durable job queue, file storage, point-in-time time-machine queries, reactive materialized views, and a built-in HTTP API. All in one process. All ACID.

okdb 3 runs a native core (written in Rust) behind the same JavaScript API as okdb 2.x. The core ships inside the npm package, for
Linux x64 (glibc 2.28 or newer). Upgrading from 2.x? Read [Upgrading to 3.0](docs/upgrade-3.0.md).

```js
const OKDB = require('@kedem/okdb');

const db = new OKDB('./mydb');
await db.open();

await db.ensureType('users', {
    indexes: [['role'], ['email']],
});

await db.put('users', 'alice', { name: 'Alice', role: 'admin', email: 'alice@example.com' });

const alice = db.get('users', 'alice'); // synchronous — instant
const admins = [...db.query('users', { role: 'admin' })]; // MongoDB-style filter

await db.close();
```

---

## Why OKDB?

Most Node.js apps reach for a separate database server — Postgres, MongoDB, Redis — even when the workload fits comfortably in a single process. OKDB eliminates that infrastructure layer without sacrificing capability.

|                          | OKDB | SQLite | MongoDB | Redis |
| ------------------------ | :--: | :----: | :-----: | :---: |
| Embedded (no server)     |  ✅  |   ✅   |   ❌    |  ❌   |
| Document model           |  ✅  |   ❌   |   ✅    |  ❌   |
| Composite indexes        |  ✅  |   ✅   |   ✅    |  ❌   |
| Full-text search         |  ✅  |   ⚠️   |   ✅    |  ❌   |
| Vector / semantic search |  ✅  |   ⚠️   |   ✅    |  ❌   |
| Multi-node sync          |  ✅  |   ❌   |   ✅    |  ✅   |
| Durable job queue        |  ✅  |   ❌   |   ❌    |  ✅   |
| Synchronous reads        |  ✅  |   ❌   |   ❌    |  ❌   |
| ACID transactions        |  ✅  |   ✅   |   ✅    |  ❌   |
| Point-in-time queries    |  ✅  |   ❌   |   ⚠️    |  ❌   |
| Materialized views       |  ✅  |   ⚠️   |   ✅    |  ❌   |

---

## Features

### ⚡ Synchronous reads

LMDB maps the database file directly into process memory. Reads run in-process and return immediately — no `await`, no round-trip.

### 🔒 ACID transactions

Inherited from LMDB's copy-on-write B+ trees with MVCC. Partial writes are impossible. Crash-safe by default.

### 🗂️ Typed collections + composite indexes

Organise records into named types (like tables or collections). Declare composite secondary indexes and OKDB maintains them automatically inside every write transaction.

```js
await db.ensureType('orders', {
    indexes: [
        ['status'],
        ['customerId'],
        ['customerId', 'createdAt'], // composite — fast filtered range scans
    ],
});

// Range scan by composite index
for (const { key, value } of db.byIndex('orders', ['customerId', 'createdAt'], {
    start: ['cust-1', 0],
    end: ['cust-1', Date.now()],
})) {
    console.log(value);
}
```

### 🔍 Full-text search

Built-in inverted-index FTS (BM25 ranking) backed by a dedicated LMDB environment. No Elasticsearch. No external process.

```js
await db.ensureType('articles');
await db.put('articles', 'a1', { title: 'Hello', body: 'hello world from okdb' });

await db.fts.register('articles', 'content', { fields: ['title', 'body'] });
await db.fts.ready('articles', 'content');

const results = db.fts.search('articles', 'content', 'hello world');
```

### 🤖 Vector embeddings + semantic search

First-class embedding pipeline. Point it at a type and a field, connect an embedder (Ollama, OpenAI, or custom), and OKDB handles indexing automatically. Nearest-neighbour search uses an in-process HNSW graph.

<!-- not-runnable: needs a running Ollama server -->

```js
const { api } = await db.embeddings.createPipeline('articles', {
    source_type: 'articles',
    field: 'body',
    dims: 1024,
    embedder: { type: 'ollama', model: 'mxbai-embed-large', url: 'http://localhost:11434' },
});

const similar = await api.searchDocs('how do I bake bread?', { limit: 10 }); // best chunk per document
```

### 🌍 Geo queries

Built-in geospatial index for radius and bounding-box queries. See [docs/indexes.md](docs/indexes.md).

### 🔄 Multi-node sync

Peer-to-peer last-write-wins replication over HTTP. No coordinator. No Raft. Nodes exchange deltas; HLC timestamps resolve conflicts. Sync needs a license (it is off on the free tier, see [Licensing](docs/licensing.md)).

<!-- not-runnable: joins a second node at a LAN address -->

```js
const db = new OKDB('./node1', {
    sync: { address: 'http://192.168.1.10:8080' },
});
await db.open();
db.http.listen(8080);

// Create an admin token first, then join a peer with it
await db.sync.join('http://192.168.1.11:8080', { token: 'cluster-bearer-token' });
```

### 📬 Durable job queue

Crash-safe job queue stored in LMDB. Consumers claim jobs, process them, and acknowledge — all without Redis. See [docs/queue.md](docs/queue.md).

```js
await db.queue.enqueue('email', { to: 'alice@example.com' });

// a consumer in this process; run more processes to scale out (each job is claimed exactly once)
await new Promise((resolve) => {
    db.queue.process('email', async (payload, ctx) => {
        console.log('sending to', payload.to, 'job', ctx.jobId);
        resolve();
    });
});
```

### 📁 File / blob storage

SHA-256 content-addressable binary blob storage, integrated with the sync system. See [docs/files.md](docs/files.md).

### 🧩 Sandboxed custom functions

Store JavaScript functions in the database, validate them, and execute them in a sandbox.

- all functions execute with env-local facades: `ctx.env`, `ctx.env.queue`, `ctx.env.files`
- mark a function `unsafe: true` to additionally receive `ctx.okdb` for cross-env access
- scripts use the contract `[async] (ctx) => {}`
- `require`, `import`, and `console` are rejected
- logging flows through `ctx.log(...)`

```js
await db.createEnvironment('analytics');
await db.env('analytics').registerType('events');
await db.env('analytics').functions.create({
    name: 'countEvents',
    source: '(ctx) => ({ count: ctx.env.getCount("events") })',
});

const run = await db.env('analytics').functions.run('countEvents');
console.log(run.result.value.count);
```

### 🔌 Built-in HTTP API + Admin UI

Zero-config REST API and a browser-based admin UI for data exploration, index management, and real-time monitoring.

```js
db.http.listen(8080);
// REST API:  http://localhost:8080/api/...
// Admin UI:  http://localhost:8080/admin/
```

Or without writing code: `npx okdb --path ./mydb --port 8080` (the `okdb` CLI, see [HTTP API](docs/http-api.md)).

### 🧠 MCP endpoint (Inspector-ready example)

OKDB also exposes an MCP server over SSE + POST:

- `GET /mcp/sse`
- `POST /mcp/messages`

For a local working example, run `examples/mcp-inspector.js` from the okdb repository, then in MCP Inspector choose the SSE transport and connect to:

- `http://localhost:8787/mcp/sse`

The server responds with browser CORS headers for common Inspector origins, accepts preflight `OPTIONS` requests, emits the POST endpoint URL over the SSE `endpoint` event, and exposes the MCP session id via the `mcp-session-id` response header. After connecting, try:

- `tools/list`
- `tools/call` with generated tools such as:
    - `system_info`
    - `system_runtime`
    - `queue_list_jobs`
    - `processor_list`

MCP tools are derived from the HTTP API's route metadata; streaming / SSE routes are not exposed as tools.

### ⚙️ Reactive processors

Composable change handlers — like database triggers, written in JavaScript. React to writes on any type, in the same transaction or asynchronously.

### ⏱️ Time-machine

Full edit history for every record. Ask what any document looked like at any point in the past — OKDB stores diffs automatically and reconstructs the state on demand. Time machine needs a license (it is off on the free tier).

<!-- licensed: timeMachine -->

```js
const db = new OKDB('./mydb', { timeMachine: true });
await db.open();
const tm = db.env('default').timeMachine;
await db.registerType('orders');

// Enable per type; tracking starts from the current clock
await tm.enable('orders');
await db.put('orders', 'ord-42', { status: 'new' });
await tm.flush('orders'); // tracking is asynchronous; flush() drains it now
const historicClock = db.env('default').getClock();
await db.put('orders', 'ord-42', { status: 'shipped' });
await tm.flush('orders');

// Point-in-time read — synchronous, no await
const snapshot = tm.getStateAt('orders', 'ord-42', historicClock); // → { status: 'new' }

// Full history for a single record
const history = tm.getHistory('orders', 'ord-42');
```

### 📊 Materialized views

Reactive aggregations that update automatically on every write. Declare a view with built-in reducers (`$count`, `$sum`, `$avg`, `$min`, `$max`, `$countBy`) or supply your own, and OKDB keeps the result in sync.

```js
const env = db.env('default');
await env.ensureType('orders');
await env.put('orders', 'o1', { status: 'completed', amount: 120, region: 'EU' });

await env.views.create('orderStats', {
    type: 'orders',
    filter: { status: 'completed' },
    reduce: {
        total: { $sum: 'amount' },
        count: { $count: true },
        avgValue: { $avg: 'amount' },
        byRegion: { $countBy: 'region' },
    },
});

// Read the live result — synchronous, O(1)
const stats = env.views.get('orderStats');
// → {
//     total:    { value: 142500 },
//     count:    { value: 312 },
//     avgValue: { value: 456.7 },
//     byRegion: { EU: { value: 140 }, US: { value: 172 } }
//   }
```

See [docs/views.md](./docs/views.md) for the full reducer reference, `map`, `$ref` sub-aggregations, lifecycle management, and HTTP/MCP surface.

### 🔑 Authentication & authorization

Multi-mode security layer built into the HTTP API. No separate auth service needed.

- **Token / session** — bearer tokens with configurable TTL
- **OIDC / OAuth2** — discovery-based, JWKS validation, email/domain allowlists
- **IP allowlists** — restrict access by network range

---

## Installation

```bash
npm install @kedem/okdb
```

> **Runtime:** Node.js 18 or newer on **Linux x64 with glibc 2.28+**. The native core ships inside the package (no compiler,
> no install scripts, no separate platform package). npm refuses to install it on other platforms; on a host it slips through
> (musl/Alpine, a forced install) `require('@kedem/okdb')` throws `NATIVE_UNAVAILABLE`. Those platforms can stay on okdb 2.x.
>
> The same native file also serves programs written in other languages through a stable C interface: see
> [C bridge](docs/c-bridge.md).

---

## Quick start

```js
'use strict';
const OKDB = require('@kedem/okdb');

async function main() {
    const db = new OKDB('./demo');
    await db.open();

    await db.ensureType('products', {
        indexes: [['category'], ['price'], ['category', 'price']],
    });

    await db.put('products', 'p1', { name: 'Widget', category: 'tools', price: 9.99 });
    await db.put('products', 'p2', { name: 'Gadget', category: 'tools', price: 19.99 });
    await db.put('products', 'p3', { name: 'Doohickey', category: 'misc', price: 4.99 });

    // MongoDB-style filter
    for (const { key, value } of db.query('products', { category: 'tools' })) {
        console.log(`${key}: ${value.name} — $${value.price}`);
    }

    // Index range scan
    for (const { key, value } of db.byIndex('products', ['price'], { start: [0], end: [10] })) {
        console.log(`${value.name} costs $${value.price}`);
    }

    await db.close();
}

main().catch(console.error);
```

---

## Documentation

| Topic                                      |                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------- |
| [Getting Started](docs/getting-started.md) | Installation, opening a database, first type, writes & reads        |
| [Querying](docs/querying.md)               | Key reads, range scans, index scans, MongoDB filters                |
| [Indexes](docs/indexes.md)                 | Composite indexes, unique indexes, geo indexes                      |
| [Transactions](docs/transactions.md)       | Multi-write atomic transactions                                     |
| [Full-Text Search](docs/fts.md)            | Registering FTS indexes, tokenizer config, search                   |
| [Embeddings](docs/embeddings.md)           | Vector pipeline, embedders, HNSW search                             |
| [Sync](docs/sync.md)                       | Cluster setup, joining peers, conflict resolution                   |
| [Queue](docs/queue.md)                     | Durable job queue, consumers, retry                                 |
| [Files](docs/files.md)                     | Blob storage, upload, download, sync                                |
| [Custom Functions](docs/functions.md)      | Stored sandboxed JS functions, env/global execution, HTTP routes    |
| [Pipelines](docs/pipelines.md)             | Composable data-flow orchestration with queue and processor drivers |
| [HTTP API](docs/http-api.md)               | REST endpoints, auth, admin UI                                      |
| [Auth](docs/auth-permissions.md)           | Token, OIDC, IP allowlist authentication                            |
| [Plugins](docs/plugins.md)                 | Extending OKDB with custom features                                 |
| [Migration](docs/migration.md)             | Export, import, backup, restore                                     |
| [Licensing](docs/licensing.md)             | Free tier, license files, limits                                    |
| [Upgrading to 3.0](docs/upgrade-3.0.md)    | What changes when you move from okdb 2.x                            |
| [C bridge](docs/c-bridge.md)               | Using the native core from C, Rust, Go, ... without Node            |

---

## Use cases

- **Local-first and offline-capable apps** — the database travels with the user
- **Desktop / Electron apps** — no bundled server process
- **Edge and IoT services** — minimal footprint, full capability
- **Data pipelines** — fast ingest, durable queue, automatic vector indexing
- **AI-powered apps** — embedding storage and semantic search are first-class
- **Audit trails and compliance** — time-machine records every change; reconstruct any past state on demand
- **Analytics dashboards** — materialized views keep aggregates live without separate query jobs

---

## License

See [LICENSE](LICENSE) for details.
