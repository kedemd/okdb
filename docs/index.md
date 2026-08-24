# OKDB

**An embedded, document-centric database for Node.js.** No separate server. No network hop. Just open a path and write data.

OKDB wraps [LMDB](https://www.symas.com/lmdb) — one of the fastest key-value stores ever built — and adds typed collections, composite secondary indexes, full-text search, vector embeddings, multi-node sync, a durable job queue, and binary blob storage. All in one process, all ACID.

---

## What it is

OKDB is a **structured layer on top of LMDB**. The design decision is simple: LMDB gives you memory-mapped, copy-on-write B+ trees with MVCC and crash-safe writes. OKDB adds everything a real application needs on top of that without changing the embedding model.

Think of it as a document store where reads are synchronous (just a pointer dereference into mmap'd memory), writes are atomic, and all the derived structures — indexes, FTS posting lists, vector graphs, changelogs — are maintained automatically inside the same transaction.

---

## Strengths

- :zap: **Reads are synchronous** — no async, no round trips, no copies
- :lock: **ACID transactions** — inherited from LMDB; no partial state ever observable
- :package: **Self-contained** — everything in one process, one set of directories
- :refresh-cw: **Multi-node sync** — LWW replication over HTTP, no coordinator
- :search: **Vector + FTS + Geo** — search primitives built in, not bolted on
- :mail: **Durable queue** — jobs survive crashes, stored in the same database
- :folder: **File storage** — SHA-256 content-addressable blobs, integrated with sync

---

## What it is not

- Not a client/server database (no PostgreSQL-style network protocol)
- Not designed for browser or Bun (Node.js only)
- Not an audit-log — the change-log is LWW-deduplicated per key, not an immutable history
- Not horizontally scalable in the traditional sense — LMDB is one writer at a time per process

---

## Core concepts at a glance

| Concept         | What it is                                                     |
| --------------- | -------------------------------------------------------------- |
| **Type**        | A named collection of records (like a table/collection)        |
| **Key**         | String primary key for each record                             |
| **Value**       | Any JSON-serialisable object                                   |
| **Environment** | An isolated LMDB database directory                            |
| **Index**       | A composite secondary index on one or more fields              |
| **Clock**       | A monotonic per-environment integer incremented on every write |
| **Change log**  | An ordered log of all mutations, keyed by clock value          |
| **Processor**   | A reactive change handler — like triggers, but composable      |

---

## Architecture overview

```
Your app code
      │
      ▼
   OKDB  (orchestrator)
      │
      ├── ~system env     ← node identity, env registry
      ├── default env     ← your data, indexes, change log
      ├── queue env       ← job queue
      ├── embeddings env  ← vector embedding status
      └── custom envs     ← whatever you create
```

All environments are LMDB directories on disk. Each has its own clock, changelog, and HLC-based sync cursor.

---

## Quick example

```javascript
const OKDB = require('@kedem/okdb');

const okdb = new OKDB('./mydb');
await okdb.open();

await okdb.registerType('notes');
await okdb.registerIndex('notes', ['author', 'createdAt']);

await okdb.put('notes', 'n1', { author: 'alice', body: 'Hello world', createdAt: Date.now() });
await okdb.put('notes', 'n2', { author: 'bob', body: 'Hey there', createdAt: Date.now() });

// Synchronous reads
const note = okdb.get('notes', 'n1');

// Index scan
for (const { key, value } of okdb.byIndex('notes', ['author'], { prefix: ['alice'] })) {
    console.log(key, value);
}

await okdb.close();
```

---

## Docs map

- [Getting Started](./getting-started.md) — install, open, first writes
- [Roles & Deployment](./deployment.md) — role flags, single-process vs multi-process topologies, deferred processing
- [Data Model](./data-model.md) — types, keys, environments, storage layout
- [Querying](./querying.md) — reads, ranges, MongoDB-style filters
- [Indexes](./indexes.md) — secondary, composite, unique, geo
- [Transactions](./transactions.md) — batching, versioning, optimistic concurrency
- [Change Log & Events](./change-log.md) — clock, changelog, processor, events
- [Processors](./processors.md) — the change-subscription primitive: modes, registration, leases
- [Sync](./sync.md) — multi-node replication
- [Full-Text Search](./fts.md) — FTS index, tokenizer, query
- [Embeddings](./embeddings.md) — vector pipeline, semantic search
- [Materialized Views](./views.md) — reactive reduce/group views over types
- [Time Machine](./time-machine.md) — per-type field-level history, point-in-time reads
- [Queue](./queue.md) — durable job queue
- [Live Subscriptions](./subscriptions.md) — signal-SSE change streams with durable sessions
- [Files](./files.md) — blob / file storage
- [TTL](./ttl.md) — per-record time-to-live
- [Custom Functions](./functions.md) — sandboxed stored JS functions, env/global scope, HTTP execution
- [Pipelines](./pipelines.md) — declarative content/embedding pipelines
- [HTTP API](./http-api.md) — built-in REST API
- [HTTP Clustering](./http-cluster.md) — the CLI's N-capable-nodes cluster
- [Process Registry](./process-registry.md) — root-wide process visibility and control
- [Auth & Sync](./auth-and-sync.md) / [Auth Permissions](./auth-permissions.md) — tokens, OAuth, grants
- [Licensing](./licensing.md) — free tier, adding a license file, PIN activation
- [Logging](./logging.md) — structured logs, retention
- [Diagnostics](./diagnostics.md) — opt-in triage tooling (write-origin ring, fatal report, loop lag)
- [Plugins](./plugins.md) — extending OKDB before open
- [Migration](./migration.md) — export, import, backup, blob integrity
- [Upgrading to 2.0](./upgrade-2.0.md) — the node-model runtime redesign: constructor changes, workers dissolved, claimed responsibilities
- [Upgrading to 2.1](./upgrade-2.1.md) — the safe-range contract: range iterators are synchronous, `READER_HELD_ACROSS_AWAIT`, the env-balloon fix
