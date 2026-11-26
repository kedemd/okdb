# OKDB

**An embedded, document-centric database for Node.js.** No separate server. No network hop. Just open a path and write data.

OKDB is built on [LMDB](https://www.symas.com/lmdb) — one of the fastest key-value stores ever built — and adds typed collections, composite secondary indexes, full-text search, vector embeddings, multi-node sync, a durable job queue, and binary blob storage. All in one process, all ACID.

---

## What it is

OKDB is a **structured layer on top of LMDB**. The design decision is simple: LMDB gives you memory-mapped, copy-on-write B+ trees with MVCC and crash-safe writes. OKDB adds everything a real application needs on top of that without changing the embedding model.

Think of it as a document store where reads are synchronous (served in-process from memory-mapped files), writes are atomic, and the derived structures — indexes, changelogs — are maintained inside the same transaction, while heavier derived work (FTS postings, vector graphs, views) is drained incrementally by background processors.

### okdb 3: a native core

okdb 3 keeps the JavaScript API of okdb 2.x and runs it on a native core written in Rust:

- **One native file.** `@kedem/okdb` ships the core as a Node addon inside the package (`native/linux-x64-gnu/`). There is no
  JavaScript fallback; the package supports **Linux x64 with glibc 2.28+** (other platforms: `NATIVE_UNAVAILABLE`, see
  [Getting Started](./getting-started.md#installation)).
- **Same API, same files.** Stores written by okdb 2.x open as-is (no migration, no index rebuild). What changed is listed in
  [Upgrading to 3.0](./upgrade-3.0.md).
- **One thread per instance.** Each `OKDB` instance runs on the Node event loop: synchronous calls go straight to the core,
  background work (processor drains, timers, lease heartbeats) runs in short slices between your callbacks.
- **Scale-out = more processes on the same path.** Processes coordinate through LMDB and shared memory (leases, the change log,
  a local UDP bus for wake-ups); see [Roles & Deployment](./deployment.md).
- **The `okdb` CLI** is a small native launcher that runs inside the same core, and the same native file serves programs written
  in other languages through a stable C interface ([C bridge](./c-bridge.md)).

---

## Strengths

- :zap: **Reads are synchronous** — no `await`, no round trips
- :lock: **ACID transactions** — inherited from LMDB; no partial state ever observable
- :package: **Self-contained** — everything in one process, one set of directories
- :refresh-cw: **Multi-node sync** — LWW replication over HTTP, no coordinator
- :search: **Vector + FTS + Geo** — search primitives built in, not bolted on
- :mail: **Durable queue** — jobs survive crashes, stored in the same database
- :folder: **File storage** — SHA-256 content-addressable blobs, integrated with sync

---

## What it is not

- Not a client/server database (no PostgreSQL-style network protocol)
- Not designed for browser or Bun (Node.js on Linux x64 only; other languages through the [C bridge](./c-bridge.md))
- Not an audit-log — the change-log is LWW-deduplicated per key, not an immutable history
- Not horizontally scalable in the traditional sense — LMDB allows one write transaction at a time per environment

---

## Core concepts at a glance

| Concept         | What it is                                                     |
| --------------- | -------------------------------------------------------------- |
| **Type**        | A named collection of records (like a table/collection)        |
| **Key**         | String (or number) primary key for each record                 |
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
      ├── ~system env     ← node identity, env registry, tokens, licenses
      ├── ~log env        ← persisted log entries
      ├── default env     ← your data, indexes, change log, queue jobs, files
      └── custom envs     ← whatever you create (each with its own queue, views, functions, ...)
```

All environments are LMDB directories on disk. Each has its own clock, changelog, and HLC-based sync cursor. Feature stores
(full-text postings, vectors, time-machine history) live in their own LMDB files under the store root.

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
for (const { key, value } of okdb.byIndex('notes', ['author', 'createdAt'], { prefix: ['alice'] })) {
    console.log(key, value);
}

await okdb.close();
```

---

## Docs map

- [Getting Started](./getting-started.md) — install, open, first writes
- [Roles & Deployment](./deployment.md) — role flags, single-process vs multi-process topologies, deferred processing
- [Upgrading to 3.0](./upgrade-3.0.md) — moving from okdb 2.x: the native package, platforms, coded errors, plugins
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
- [C bridge](./c-bridge.md) — the native core's C interface for non-Node hosts
- [Upgrading to 2.0](./upgrade-2.0.md) (history) — the node-model runtime redesign: constructor changes, workers dissolved, claimed responsibilities
- [Upgrading to 2.1](./upgrade-2.1.md) (history) — the safe-range contract: range iterators are synchronous, `READER_HELD_ACROSS_AWAIT`, the env-balloon fix
