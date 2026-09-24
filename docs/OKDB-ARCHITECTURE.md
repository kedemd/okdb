# OKDB — Technical Architecture Reference

> Written for AI consumption. Dense, precise, no fluff.
> Covers: data model, storage layer, change tracking, indexes, transactions,
> features, plugin model, known design constraints, and potential enhancements.

---

## 1. What OKDB Is

OKDB is a **document-centric embedded database** for Node.js, built as a structured
layer on top of [LMDB](https://www.symas.com/lmdb) (via the `lmdb` npm package).
It is **not** a client/server database — it runs in-process, memory-mapped, with
full ACID transactions inherited from LMDB.

The core value proposition is: take raw LMDB key/value durability and add on top
of it typed collections, composite secondary indexes, a global change-log with
logical clocks, vector embeddings, multi-node sync, a job queue, and a pluggable
search engine — all without a separate process or network hop.

**Runtime: Node.js only.** No browser, no Bun (untested), no Deno. Designed for
single-node embedded use or multi-process cluster topologies where each process
has its own LMDB environment.

---

## 2. Dependency Stack

```
Application code
      │
      ▼
  OKDB class  (okdb.js)          ← single public API surface
      │
      ├─ lmdb (npm)            ← ACID B-tree storage, mmap, ordered-binary encoding
      ├─ sift (npm)            ← MongoDB-style filter expressions for query()
      ├─ uuid (npm)            ← transaction IDs
      ├─ hnswlib-node (npm)    ← HNSW nearest-neighbour graph for vector search
      └─ ws / socketit         ← WebSocket transport for sync/admin UI
```

LMDB provides: copy-on-write B+ trees, MVCC readers, `dupSort` duplicate-key
sub-databases, `ordered-binary` encoding (consistent ordering of typed keys),
`useVersions` for optimistic concurrency, automatic compression (LZ4), and
optional AES-256 encryption at rest. OKDB exposes all of these.

---

## 3. Physical Storage Layout (Multi-Environment)

OKDB uses **multiple LMDB environments** (separate on-disk directories), each
opened with `lmdb.open(path)`. Each environment contains multiple named
**sub-databases** (`openDB`). This design keeps high-churn derived data (queues,
FTS posting lists, vector indexes) physically separate from user data, enabling
independent compaction, encryption, and sync control.

### 3.1 Directory Layout

```
<okdb-root>/
  root/              ← Root LMDB (tiny, metadata only — no user data)
  default/           ← User types, changelog, HLC clock  (sync: on)
  queue/             ← Queue jobs/payloads/stats          (sync: on)
  embeddings/        ← Embedding doc_status + models      (sync: on)
  vectors/           ← HNSW graph files + LMDB snapshots  (sync: off)
  ~fts/
    <env>/           ← Shared FTS env: posting lists + dicts  (sync: off, rebuildable)
    <env>_docs/      ← Shared FTS env: LZ4-compressed forward index
  blobs/             ← File attachment BLOBs
```

Custom envs (created via `okdb.createEnvironment(name, opts)`) each get their
own sub-directory named after the env.

### 3.2 Root LMDB

Tiny metadata-only store. Never holds user data.

```
root/
  ├── __identity           → { id, created }          node UUID
  ├── __env_registry       → { name, sync, options }  per-env config
  └── __sync_peers         → { peer_id → peerState }  per-peer sync cursor
```

### 3.3 Default / User Env (and all sync:on envs)

Each sync-enabled environment has the same internal structure:

```
<env>/
  ├── "clock"              → global monotonic integer clock
  ├── types                → typeName → metadata (ftsIndexes, fieldSchema, …)
  ├── changes              → changeId → latest clock(int)
  ├── clocks               → clock(int) → change object
  │
  └── per-type (for each registered type T):
        type:T             root sub-db (lifecycle, transaction records)
        type:T:data        key → value  (useVersions=true, compression)
        type:T:index       indexName → index metadata
        type:T:clockToChange  clock(int) → changeId
        type:T:keyToChange    primaryKey → changeId
        type:T:ttl            expiresAt → primaryKey (dupSort, ordered-binary)
        type:T:ttlByKey       primaryKey → expiresAt
        │
        └── per-index (for each index I on type T):
              type:T:index:I  dupSort=true, ordered-binary keys+values
                              key  = [...fieldValues, null(sentinel)]
                              value = primaryKey(string)
```

**Key design notes:**

- The `clocks` DB is the authoritative append-only event log (WAL replay source).
- `changes` deduplicates: each `changeId` maps to the _latest_ clock it was
  written at. Old entries are tombstoned when a key is overwritten (LWW per key).
- `clockToChange` / `keyToChange` are per-type projections allowing efficient
  per-type clock scans and key→latest-change lookups without scanning the global log.
- Index sub-dbs use `dupSort: true`. The same index key (e.g. `["alpha", null]`)
  may map to multiple primary keys. `null < string < number` ordering via
  `ordered-binary` codec..

### 3.3a Unique Secondary Indexes

A secondary index may be declared **unique** by passing `{ unique: true }` to
`registerIndex()`. The flag is stored in index metadata and replicated via sync.

**Local enforcement:**

- `_write()` calls `_checkUniqueConstraints()` before the LMDB write.
- If an existing record holds the same index key, `OKDBUniqueConstraintError`
  (code `UNIQUE_CONSTRAINT`) is thrown inside `db.transactionSync()`, aborting
  the entire transaction atomically.

**Sync-origin writes (CRDT conflict model):**

- When `origin !== null` (write arrived via sync), the uniqueness check is bypassed
  so no incoming change is ever lost.
- If duplicate index keys exist after the write, the conflict is recorded in
  the `__unique_violations` LMDB sub-db.
- **Winner selection** is deterministic: highest HLC timestamp wins; ties broken
  by lexicographically largest origin string (same ordering as `compareChangeLWW`).
- Violations resolve automatically when the losing record is removed or its
  index-field value changes.

**Violation tracking storage:**

```
__unique_violations   key = type@indexName@serializedIndexKey
                      value = { type, index, indexKey, entries[], winner, count,
                                detectedAt, updatedAt }
```

- NOT synced — computed locally from synced data.
- Emits `EVENTS.UNIQUE_VIOLATION` on conflict, `EVENTS.UNIQUE_VIOLATION_RESOLVED`
  on resolution.

**Query API:**

| Method                                     | Description                                              |
| ------------------------------------------ | -------------------------------------------------------- |
| `env.getUniqueViolations(type, index?)`    | List all violations (optional index filter)              |
| `env.hasUniqueViolations(type, index)`     | Boolean — any violations?                                |
| `env.getUniqueViolation(type, index, key)` | Single violation record or `null`                        |
| `env.byIndex(type, index)`                 | Winner-only by default; `includeViolations:true` for all |

**REST endpoints:**

```
GET  /api/:env/type/:type/unique-violations
GET  /api/:env/type/:type/index/:index/violations
```

**Geo indexes cannot be unique.** Geohash collisions make uniqueness semantics
ambiguous; registration is rejected at the API layer.

**Admin UX:**

- The Create Index modal exposes a **◆ Unique** checkbox (disabled when Geo is selected).
- The Manage tab shows **◆ unique** badge alongside index names.
- The index dropdown in the Data tab appends **◆** to unique index option labels.

### 3.3b Foreign Keys (Ref Constraints)

Foreign keys are declared inline in JSON Schema via a custom `ref` annotation on
string properties. They enforce referential integrity within a single environment.

**Schema declaration:**

```json
{
    "type": "object",
    "properties": {
        "authorId": {
            "type": "string",
            "ref": { "type": "Author", "onDelete": "cascade" }
        }
    }
}
```

- `ref.type` — target type name (must exist in the same env).
- `ref.onDelete` — one of `no_action` (default), `cascade`, `set_null`, `restrict`.
- Nested properties are supported (e.g. `properties.meta.properties.ownerId`).
  The field path is tracked as dot-notation (`meta.ownerId`).
- `null` values in ref fields are treated as "no reference" and always allowed.

**Ref extraction and caching:**

On `open()` and on every `setSchema()` / `dropSchema()`, the env scans all stored
schemas and rebuilds an in-memory **ref cache**:

```
_refCache = {
  outgoing: Map<sourceType, [{ field, targetType, onDelete }]>,
  incoming: Map<targetType, [{ sourceType, field, onDelete }]>
}
```

This allows O(1) lookup of "what refs does this type have?" and "what types
reference this target?".

**Reverse ref index (`__ref_index`):**

A dedicated LMDB sub-db tracks which documents reference which targets:

```
__ref_index   key = targetType@targetKey@sourceType@sourceKey@fieldPath
              value = true
```

- Updated atomically inside `_write()` after `db.put()`.
- Old ref entries are removed before new ones are written (handles updates).
- Enables efficient prefix scan on delete: "find all docs referencing Author@123".

**Write-time validation (`_checkForeignKeys`):**

Called inside `_write()` after schema validation, before index updates:

1. For each ref field in the document, resolve the field value.
2. If value is `null`/`undefined` → skip (nullable FK).
3. Check if `targetType@targetKey` exists via `env.get()`.
4. If target missing:
    - **enforce:true + local write** → throw `OKDBForeignKeyError` (code
      `FOREIGN_KEY_VIOLATION`), aborting the LMDB transaction.
    - **enforce:false or synced write** → write succeeds, violation recorded in
      `~ref_violations` internal type.

**Delete-time cascade (`_processDeleteCascade`):**

Called inside `_remove()` before `db.remove()`:

1. Prefix-scan `__ref_index` for all entries matching `targetType@targetKey@`.
2. Group results by `onDelete` rule.
3. **restrict:** If any incoming refs have `onDelete: restrict` AND the delete is
   local (`origin === null`), throw `OKDBForeignKeyDeleteError`. Synced deletes
   bypass restrict (CRDT-safe — never reject incoming data).
4. **cascade:** Recursively call `_remove()` on each referencing document. A
   `_cascadeVisited` Set tracks `type@key` to prevent infinite cycles.
5. **set_null:** Call `_write()` on each referencing document with the ref field
   set to `null`. The `_cascading` flag is passed to suppress re-validation.
6. **no_action:** No cleanup — dangling refs may result.

**Violation tracking:**

```
~ref_violations   key = sourceType@sourceKey@fieldPath
                  value = { sourceType, sourceKey, fieldPath, targetType,
                            targetKey, detectedAt }
```

- NOT synced — locally computed from synced data.
- Automatically cleared when the referencing doc is updated to a valid target,
  removed, or when the target is created.
- Emits `EVENTS.REF_VIOLATION` on detection, `EVENTS.REF_VIOLATION_RESOLVED`
  on resolution.

**Retroactive schema application (`_syncRefIndex`):**

When `setSchema()` introduces refs on a type that already has data:

1. Clear all existing `__ref_index` entries for that source type.
2. Scan all documents of the type.
3. For each document, populate `__ref_index` entries.
4. If a ref target is missing, record a `~ref_violations` entry.

`dropSchema()` clears all ref index entries and ref violations for the type and
rebuilds the ref cache.

**Query API:**

| Method                                                  | Description                          |
| ------------------------------------------------------- | ------------------------------------ |
| `env.getRefViolation(sourceType, sourceKey, fieldPath)` | Single violation or `null`           |
| `env.listRefViolations(type?)`                          | All violations, optional type filter |

**REST endpoints:**

```
GET  /api/env/:env/ref-violations             → all ref violations
GET  /api/env/:env/ref-violations/:type       → violations for a specific type
```

**Design constraints:**

- **Same-env only.** Cross-environment refs are not supported — each env is an
  independent replication unit.
- **Scalar refs only.** Array-of-refs (e.g. `{ type: "array", items: { ref: … } }`)
  is not yet supported.
- **No composite refs.** Each ref field points to exactly one target type/key.

### 3.4 FTS Environments

All FTS data for one OKDB env lives in a pair of shared LMDB environments. Individual indexes are distinguished by an auto-increment `ftsId` used as a key prefix — no new files per index.

```
~fts/<env>/                                      ← uncompressed env
  ├── post       dupSort  [ftsId, token] → docId         (live "add" tier)
  ├── postDel    dupSort  [ftsId, token] → docId         (live "delete" tombstones)
  ├── frozen              [ftsId, token] → Roaring blob  (compacted tier)
  ├── dict                [type, 'k', docKey] → docId    (docKey ↔ docId interning)
  └── tokenDict           ['k', token] → tokenId         (token ↔ tokenId interning)

~fts/<env>_docs/                                 ← LZ4-compressed env
  └── docs                [ftsId, docId] → tokenId[]     (forward index)
```

- **Two-tier writes.** Hot path lands in the live tier (`post` / `postDel`) — O(1) dupSort puts. The compactor periodically merges live entries into per-token Roaring bitmaps in `frozen` and clears the live tier.
- **Reads** merge all three tiers: `frozen ∪ liveAdds − liveDeletes`. Roaring's set ops keep this essentially free.
- **ID interning.** `dict` maps (type, docKey) → uint32 docIds so posting-list values and forward-index keys are 4 bytes instead of full strings. `tokenDict` maps tokens → uint32 tokenIds so forward-index values are integer arrays instead of token strings.
- Always `sync: false` — fully rebuildable from the env's type data.
- FTS metadata (field config, status, created/updated timestamps, storage `format` version) is stored in `<env>/types` under `ftsIndexes[name]` — this IS synced. The storage format auto-migrates on open by triggering a rebuild for any index whose format is older than the current code.
- Writes are async via a background processor (one per type). `fts.flush(type)` waits for the processor and runs the compactor.
- `fts.compactStorage(env)` reclaims slack inside the FTS data.mdb files (LMDB never shrinks files in place). `env.compact()` runs both the main-data and FTS compactions in one operation.

### 3.5 Vectors Environment

```
vectors/
  ├── <name>:meta    HNSW graph metadata + snapshot clock
  ├── <name>:vectors key → Float32Array  (LMDB-backed vector store)
  └── <name>.hnsw    HNSW graph file (separate file, not a sub-db)
```

- `sync: false` — rebuilt from embeddings pipeline, not synced.

### 3.6 Queue Environment

```
queue/
  ├── ~queue_jobs       job records
  ├── ~queue_payloads   job payloads (separate for large-payload efficiency)
  ├── ~queue_buckets    scheduling buckets
  └── ~queue_stats      counters
```

- `sync: on` — queue state replicates across cluster nodes.
- Changelog and HLC clock are independent from the default env.

### 3.7 Embeddings Environment

```
embeddings/
  ├── ~emb:doc_status   per-document embedding computation status
  └── ~emb:models       embedding model registry
```

- `sync: on` — embedding status and model registry replicate.

---

---

## 4. OKDB Orchestrator + OKDBEnv Model

### 4.1 Two-Layer Architecture

```
OKDB  (okdb.js)               ← orchestrator: lifecycle, features, public API
 │
 ├── _rootDb                ← Root LMDB (metadata: identity, env registry, peers)
 │
 ├── _envs: Map<name, OKDBEnv>
 │     ├── "default"        ← OKDBEnv (default user-data env)
 │     ├── "queue"          ← OKDBEnv (queue env, auto-created on open)
 │     ├── "embeddings"     ← OKDBEnv (embeddings env, auto-created on open)
 │     ├── "vectors"        ← OKDBEnv (vectors env, sync:false)
 │     └── "<custom>"       ← OKDBEnv (user-created via createEnvironment)
 │
 └── features
       fts, sync, queue, embeddings, engines, files, plugins, meta, …
```

`OKDB` is the **orchestrator**. It owns lifecycle, wires features together,
and exposes a convenience API that delegates to `env('default')` for all
common operations (`put`, `get`, `query`, `registerType`, etc.).

`OKDBEnv` is the **data layer**: one LMDB environment + its type sub-dbs +
its own clock + its own HLC + its own processor + its own changelog.

### 4.2 OKDBEnv Internals

Each `OKDBEnv` instance:

| Field             | Purpose                                                    |
| ----------------- | ---------------------------------------------------------- |
| `db`              | The `lmdb.RootDatabase` for this env                       |
| `typeSubDbs`      | `Map<typeName, typeMap>` — all open type sub-dbs           |
| `typesDb`         | Sub-db storing type metadata (field schema, FTS config, …) |
| `clockToChangeDb` | `clock(int) → change object` — the event log               |
| `changeToClockDb` | `changeId → clock` — deduplication index                   |
| `processor`       | `OKDBProcessor` instance scoped to this env                |
| `_sync`           | `boolean` — whether this env participates in sync          |
| `_hlc`            | HLC state (uint64 encoded)                                 |

### 4.3 Environment API

```js
// Get an env by name (throws if not found)
okdb.env('default')          // → OKDBEnv
okdb.env('queue')            // → OKDBEnv

// Create a new env (registers in root LMDB + opens LMDB directory)
const myEnv = await okdb.createEnvironment('analytics', { sync: true })

// Envs have the same write/read API as OKDB itself
await myEnv.registerType('events')
await myEnv.put('events', 'e1', { action: 'click' })
const val = myEnv.get('events', 'e1')
for (const e of myEnv.query('events', { action: 'click' })) { … }
```

### 4.4 Sync Flag

| `sync: true`                                | `sync: false`               |
| ------------------------------------------- | --------------------------- |
| Env changes appear in `sync.calculateDelta` | Excluded from sync entirely |
| Has changelog + HLC clock                   | No changelog                |
| `_env` tag on changes                       | Never replicated            |
| default, queue, embeddings                  | vectors, fts\_\*            |

---

## 5. The `OKDB` Class — Public API Surface

`okdb.js` is the single export and entry point. All features hang off it.

### Lifecycle

```js
const okdb = new OKDB(path, options); // sync — no IO
await okdb.open(); // opens LMDB env, starts features
await okdb.close(); // drains, stops features, closes env
```

State machine: `CREATED → STARTING → STARTED → STOPPING → STOPPED`

### Schema Management

```js
await okdb.registerType(type); // creates per-type sub-dbs
await okdb.dropType(type); // drops all sub-dbs for type
await okdb.registerIndex(type, ['field']); // registers composite index, async rebuild
await okdb.dropIndex(type, ['field']); // clears index sub-db
await okdb.ensureType(type, { indexes: [] }); // idempotent upsert
```

Index names are stored as canonical `parts.join('~')` strings (e.g. `category~score`).
The `~` separator is the only place where string splitting is allowed — everywhere
else index identity is always a `string[]`.

### Write API

```js
// All four methods create a single-op transaction internally
await okdb.put(type, key, value); // upsert
await okdb.create(type, key, value); // throws ALREADY_EXISTS if key exists
await okdb.update(type, key, value); // throws NOT_FOUND if key absent
await okdb.remove(type, key); // throws NOT_FOUND if key absent

// All accept { ifVersion, version, timestamp, origin }
// ifVersion: optimistic concurrency guard
// version: explicit version override (for sync/import)
// origin: node UUID for change attribution (sync anti-echo)
```

### Read API

```js
okdb.get(type, key); // value | undefined, synchronous
okdb.getMany(type, keys); // value[], synchronous
okdb.getEntry(type, key); // { value, version } | undefined
okdb.getRange(type, rangeOptions); // lazy LMDB cursor (iterable)
okdb.getByPrefix(type, prefix); // lexicographic prefix scan
okdb.getValues(type, rangeOptions); // lazy iterable of values only
okdb.getKeys(type, rangeOptions); // lazy iterable of keys only
okdb.getCount(type); // integer record count
okdb.byIndex(type, index, rangeOptions); // lazy iterable of { key, value, version, indexKey }
okdb.query(type, filter, options); // MongoDB-style filter via sift; optional index
```

**All reads are synchronous** (LMDB mmap means no async I/O for reads).
`getRange`, `byIndex`, `query` return LMDB lazy iterables — they are cursor-backed
and **invalidated by any write transaction opened on the same LMDB environment**.
Callers that mix async work with open cursors must materialize first
(`Array.from(cursor)`).

### Change Log API

```js
okdb.getClock(type?)                          // current global or per-type clock
okdb.getChanges(type?, start, end, options)   // inclusive [start, end] range
```

`getChanges` returns an iterable of `{ clock, id, type, key, action, timestamp, origin, txnId }`.
The `end` bound is **inclusive** (OKDB adds `+1` internally before passing to LMDB).
Without `type`, it scans the global `clockToChangeDb`.
With `type`, it scans the per-type `clockToChange` projection then cross-references
the global `clockToChangeDb` for the full change object.

### Batch Transactions

```js
const txn = okdb.transaction();
txn.put(type, key, value);
txn.remove(type, key);
// ... N ops
await txn.commit(); // all-or-nothing, one LMDB transaction
txn.rollback(); // discard pending actions
```

`OKDBTransaction` accumulates operations as an `actions[]` array and replays them
inside a single `okdb.db.transaction()` call on commit. It also optionally holds
an LMDB read transaction (`useVersions` snapshot) for consistent reads during
the accumulation phase.

---

## 6. Change Logging — The Logical Clock

Every write (put, remove, registerType, registerIndex, dropType, dropIndex) calls
`_logChange(change, oldValue, newValue)` _inside_ the active LMDB transaction.

```
global clock  ← atomically incremented (stored as kv pair "clock" in root env)
global clocks db   clock → { id, type, key, action, timestamp, origin, txnId }
global changes db  changeId → latestClock          (dedup index)

per-type clockToChange   clock → changeId
per-type keyToChange     key → changeId            (latest change per primary key)
```

**Deduplication semantics:** When a key is written twice, the first clock entry
in the global log is removed (tombstoned from `clockToChangeDb`) and the
`changeToClockDb` pointer is updated. The per-type `clockToChange` mirrors this.
Result: the log contains at most **one entry per primary key** — always the most
recent action. This makes `getChanges` a true "what is the current state delta"
query rather than a full audit trail.

**Post-commit event emission:** Events (`item:create`, `item:update`, `item:remove`,
`system:clock_change`, `system:clock_change@type`, `bus:poke`) are emitted via
`okdb.db.committed.then(...)` — after the LMDB transaction durably commits.
This ensures listeners never see speculative data.

---

## 7. Secondary Indexes

Indexes are:

- Composite: defined as `string[]` of field paths (dot-notation supported)
- Stored in `dupSort: true` LMDB sub-databases with `ordered-binary` key encoding
- Key format: `[...fieldValues, null]` — the trailing `null` is a sentinel that
  ensures the ordered-binary sort places all entries for a given composite prefix
  contiguously, enabling efficient range scans
- Value: primary key string

**Index maintenance** happens inside `_write`/`_remove` via `_updateItemIndexes`:
for each registered index, `_updateItemIndex` extracts the old and new field
values, and if they differ, removes the old entry and inserts the new one — all
within the same LMDB transaction.

**Index build** (`resetIndex`) reads a snapshot of the data DB and processes it
in batches of 10,000, using `ifVersion` to skip stale entries. An `INDEX_STATE`
enum tracks `CREATING → RESETTING → READY`. A `_indexReadyPromises` map allows
consumers to `await okdb.indexReady(type, index)`.

**Indexes on CREATING-state types** skip the old-value removal step — prevents
spurious removes during initial populate.

---

## 8. Features

All features are instantiated in the `OKDB` constructor and attached as
`this.{name}`. They start/stop with the database lifecycle.

### 8.1 `okdb-http` — Internal Route Dispatcher

Not an HTTP framework. A minimal hand-rolled dispatcher that:

- Compiles URL patterns into regexes with named capture groups
- Supports middleware chains (`okdb.http.use(fn)`)
- Handles `Basic` and `Bearer` auth, HMAC signatures, cookie parsing
- Can optionally start a `node:http` server (`okdb.http.listen(port)`)
- Used by all features to register their REST endpoints without external deps

### 8.2 `okdb-bus` — UDP Multicast Discovery Bus

Sends `bus:poke` UDP datagrams on a multicast group (`239.1.2.3:30303` by default)
whenever the clock changes. Purpose: notify sibling processes on the same LAN that
new data is available so they trigger a sync reconcile. Stateless — carries only
a type name hint. No reliability guarantees; loss is acceptable (sync reconciles
periodically anyway).

### 8.3 `okdb-sync` — Last-Write-Wins Multi-Node Replication

Peer-to-peer sync over HTTP (no central coordinator):

- Each node exposes `GET /api/sync/delta?from_clock=N` (via `okdb-sync-http.js`)
- Peers are stored in the `~sync_nodes` OKDB type (replicated) and tracked with
  local-only progress records (stored in root LMDB under `__sync_peers`, not replicated)
- Reconciliation: pull delta from peer → apply LWW comparison → write if newer
- LWW comparison: `(timestamp, origin)` — lexicographic tie-break on origin UUID
- Anti-echo: changes whose `origin === okdb.id` are skipped on apply
- Auto-reconcile is clock-change-driven, not timer-based

**Multi-env sync (step 4):** `calculateDelta` spans ALL `sync:true` envs.
Each change is tagged with `_env: envName`. The response includes a `clocks`
map (`{ default: N, queue: N, embeddings: N }`) so each env's cursor advances
independently. Legacy `from_clock` (single integer) is treated as
`{ default: N }` for backward compatibility. `applyChange` routes each change
to the correct env on the receiving node.

**Non-syncable envs** (`sync: false`): vectors, fts\_\* — excluded from delta.
These are rebuilt from synced data on each node.

**Conflict model:** Timestamp-based LWW. No CRDT, no vector clocks. The node
with the higher wall-clock timestamp wins. This is intentional simplicity — the
system is designed for loosely-coupled eventual consistency, not strong ordering.

### 8.4 `okdb-queue` — Durable Job Queue

A full-featured job queue built entirely on OKDB types — stored in the `queue/`
env (not the default env):

- Types: `~queue_jobs`, `~queue_payloads`, `~queue_buckets`
- Supports: priorities, tags, TTLs, retry with exponential backoff, dead-letter,
  cron scheduling, token-bucket rate limiting (buckets), and per-job result storage
- Workers claim jobs (`STATUS.PENDING → CLAIMED`) and mark them done/failed
- Reconciler handles stale claims, retry scheduling, cron advancement
- Stats are maintained by a `~queue_stats` view (`$count` + `$countBy`
  reductions over `~queue_jobs`) — auto-updated by the views processor

The queue is OKDB-native: jobs survive crashes, job history is queryable,
all mutations go through the queue env's change log, and queue state replicates
across cluster nodes via multi-env sync.

### 8.5 `okdb-embeddings` — Vector Embedding Pipeline

Orchestrates four engine types for document embedding and nearest-neighbour search:

| Engine type     | Role                                                                  |
| --------------- | --------------------------------------------------------------------- |
| `embedder`      | Named connection to an ML model (Ollama/OpenAI/custom)                |
| `indexer`       | Watches a OKDB type's change log, embeds docs inline or enqueues jobs |
| `embed-worker`  | Consumes queue jobs, calls embedder, calls `markDone`                 |
| `vector-search` | In-memory HNSW graph over a persistent vector store                   |

Storage: `OKDBVectorStore` stores `Float32Array` vectors in LMDB sub-databases
keyed by `storage_key`. The HNSW graph (`hnswlib-node`) is rebuilt from storage
on restart.

Two pipeline modes:

- **inline**: indexer → embedder directly. Simple. Blocks the change-log consumer.
- **queue**: indexer → `okdb-queue` → embed-worker(s) → embedder. Allows
  concurrency control, retries, and multi-process workers.

`createPipeline(key, config)` is the one-call convenience API that provisions all
four engine types and wires them together.

### 8.6 `okdb-engines` — Persistent Named Services

A generic lifecycle manager for named, typed, driver-backed services whose
configuration and status are stored in the `~engines` OKDB type. Engines survive
restarts: on `open()`, all persisted engines are restored and their drivers' `start`
methods are called.

Lifecycle: `created → online ↔ error → stopped`

Used by the embeddings feature internally. Also available as a general extension
point: register a driver, create an engine, its `config` object lives in OKDB.
Config is updatable at runtime for drivers that implement `patchConfig`
(embedder, indexer, vector-search, queue-worker); a config PATCH restarts the
engine, and identity fields (source, storage key, dims) stay immutable.

Storage-format versioning: the data directory records the okdb version its
layout was last migrated to (`__storageVersion` in `~system`). Migrations are
keyed by the okdb release that introduces them; on `open()`, pending ones run
once per store under a cross-process LMDB mutex and are logged durably to the
`~migrations` type (per-id completion — several migrations may ship in one
release). Opening a store whose layout is newer than the running build fails
fast (`STORE_VERSION_NEWER`; `OKDB_ALLOW_NEWER_STORE=1` overrides); a plain
package downgrade without layout changes only warns. Live peers on the same
path running a different okdb build are warned about via the process registry
heartbeat. Inspect via `GET /api/system/storage` or the admin System →
Storage Format card.

### 8.7 `okdb-search` — Pluggable Search Engine Framework

A driver/engine pattern for full-text or structured search that is independent of
the embeddings feature:

- Register drivers (`registerDriver(driverDef)`) — each driver provides a `build`
  function that returns a runtime with an API
- Create engine instances keyed by `searchKey`, backed by a definition stored in
  `~search` OKDB type
- `OKDBSearchEngine` handles lifecycle, clock subscription, mutation serialization,
  and checkpoint orchestration (via `CheckpointController`)
- Projections, materializers, executors are driver responsibilities — the engine
  never inspects documents directly

### 8.8 `okdb-plugins` — Plugin System

Pre-open extension mechanism:

- `okdb.plugins.register(module, options)` — registers a plugin before `open()`
- Dependency declaration via `module.requires: string[]`
- Two lifecycle hooks: `start(okdb)` (after open, async) and `stop(okdb)` (before close)
- Plugins can attach to `okdb.{module.name}` — namespace is guarded against collisions

### 8.9 `okdb-meta` — Schema Introspection

Read-only. Exposes: `listTypes()`, `describeType(type)` (count, fields, indexes),
`describeIndex(type, index)`, `listChanges(...)`. No caching.

Field schema is observed on write via `_mergeFieldSchema` — each new field/type
combination is persisted to the type metadata. Provides coarse type information
(`string | number | boolean | null | array | object`) per field.

### 8.10 `okdb-migrate` — Export / Import

Serializes all types and their records to a JSON-friendly structure. Indexes are
excluded (rebuilt on import). Optionally exports the change log. Import drops all
existing types and recreates them.

### 8.11 `okdb-admin` — Admin UI Backend

Serves a static web UI from `src/features/admin/public/`. Registers HTTP routes
for type/index/record management, system info, and live monitoring.

### 8.12 `okdb-api` — REST API

Registers standard CRUD HTTP routes:

- `GET/POST/PUT/PATCH/DELETE /api/type/:type/:key`
- `GET /api/type/:type` (list with range/limit/offset)
- `GET /api/changelog`, `GET /api/type/:type/changelog`
- `GET /api/info`

Changelog endpoints expose `before`/`after` clock query params (inclusive bounds).

### 8.13 `okdb-logger` — Structured Logger

Set-based sink router. Entries have the shape `{ level, msg, meta, context, ts }`.

- **`meta`** — machine-readable system identity, set at `child()` call time: `feature`, `env`, `fn`, `runId`, `runnerId`.
- **`context`** — user-provided call-site data (second arg to any log call). Display only, not filtered on.
- **`child(extraMeta)`** — returns a new logger sharing the same sinks but with additional `meta` fields shallow-merged. Used by every feature to stamp entries with `{ feature: '...' }`.
- **`attach(fn)`** / **`okdb.events.on('log', fn)`** / **`okdb.logs`** ring buffer — three consumer APIs.
- Console sink attached by default; suppresses `meta.feature === 'functions'` (function logs are stored in run records and surfaced via Admin UI).
- Optional Pino plugin available for structured JSON output in production.

---

## 9. Transaction Model In Detail

```
okdb.transaction()             → OKDBTransaction (accumulates actions)
  .put / .remove / ...        → pushes { action, args } onto this.actions[]
  .commit()                   → calls okdb.db.transaction(cb)
                                  cb: replays each action via okdb._put / _remove / etc.
                                  each _* method:
                                    1. validates key/value
                                    2. reads existing entry (for version/oldValue)
                                    3. calls db.put / db.remove
                                    4. calls _updateItemIndexes (synchronous, in-txn)
                                    5. calls _logChange (increments clock, writes change DBs)
                                  all inside ONE lmdb transaction → atomic
  .rollback()                 → clears actions[], closes read txn handle
```

**Consequences:**

- All index updates and change-log entries are written atomically with the data.
  There is no window where a secondary index is inconsistent with the primary data.
- The clock is incremented inside the transaction — clock values are contiguous
  and monotonically increasing per LMDB commit.
- Post-commit events are deferred via `.committed` promise — guaranteed
  not-before-durable.

---

## 10. Internal Naming Conventions

| Convention          | Meaning                                                      |
| ------------------- | ------------------------------------------------------------ |
| `type:T`            | Prefix for all sub-databases belonging to type T             |
| `~type_name`        | System-internal OKDB type (not user-visible by default)      |
| `item:T@key`        | Change ID for a data record in type T with primary key `key` |
| `type:T` (changeId) | Change ID for a type registration/drop event                 |
| `index:T@indexName` | Change ID for an index registration/drop event               |
| `parts.join('~')`   | Canonical index name (only ever split at storage boundaries) |

---

## 11. Known Architectural Constraints

### C1. Single-process writer

LMDB supports one writer at a time. Multiple Node.js processes can open the same
environment, but writes are serialized. OKDB does not implement a write-queue
across processes — that is the application's responsibility (or use the sync feature for multi-node topologies with separate environments).

### C2. Cursor invalidation on async writes

LMDB lazy cursors (`getRange`, `byIndex`) are invalidated the moment a write
transaction is opened in the same environment. Any `await` between cursor creation
and exhaustion risks stale/invalid cursor state. OKDB documents this and the
indexer explicitly materializes with `Array.from()` before any `await`.

### C3. ~~No TTL / expiry on data records~~ (Resolved)

Native per-record TTL is now supported. Each type has two TTL sub-databases
(`type:T:ttl` for sweep ordering and `type:T:ttlByKey` for O(1) lookup).
Public API: `setTTL(type, key, ttlMs)`, `getTTL(type, key)`, `clearTTL(type, key)`.
Background sweep via `startTTLSweep(intervalMs)` and manual `sweepExpiredTTL()`.
TTL is also available inside transactions and via HTTP API routes.

### C4. LWW sync is not causally ordered

The sync feature uses `(timestamp, origin)` LWW. Wall-clock drift between nodes
can cause causally-later writes to lose to causally-earlier ones. There is no
vector clock or HLC (Hybrid Logical Clock) to prevent this.

### C5. In-memory HNSW index

The vector search graph (HNSW via `hnswlib-node`) is fully in-memory. Vectors are
persisted in LMDB but the graph is rebuilt on each restart. For large corpora
(millions of vectors) this startup time and memory footprint become significant.

### C6. Field schema is append-only and coarse

`_mergeFieldSchema` only adds to the observed field/type set — it never prunes.
Schema is coarse (`string | number | ...`) not structural. No schema validation
on write; bad data silently persists.

### C7. Change log deduplication loses history

The LWW deduplication in the change log means the full mutation history is NOT
preserved — only the most recent action per primary key. This is by design for
sync efficiency but makes audit logging and event sourcing impossible with the
current log.

### C8. No query planner

`query()` applies the `sift` filter post-scan. When `options.index` is given it
narrows the scan range, but there is no cost-based index selection. Multi-field
queries without the right composite index will do full scans.

### C9. Single EventEmitter (no backpressure)

All events (`item:create`, `system:clock_change`, etc.) are emitted synchronously
after commit via a standard Node.js `EventEmitter`. There is no backpressure,
buffering, or slow-listener isolation. A slow `item:create` handler blocks all
subsequent event delivery for that process.

---

## 12. Potential Enhancements

These are ordered roughly by impact-to-effort ratio.

### E1. Hybrid Logical Clocks (HLC) for sync

**Problem:** Wall-clock LWW cannot correctly order concurrent writes on nodes
with clock skew.
**Enhancement:** Replace `timestamp` with an HLC value `(physicalMs, logicalCounter)`
encoded as a 64-bit integer. HLC advances monotonically and embeds causal ordering
without coordination. All existing sync comparison logic (`compareChangeLWW`) can
be adapted to compare HLC values. This is a well-known, low-complexity fix.

### E2. ~~TTL index on data records~~ (Implemented)

**Problem:** No native expiry (C3).
**Resolution:** Two LMDB sub-databases per type: `type:T:ttl` (dupSort,
`expiresAt → primaryKey` for efficient range sweep) and `type:T:ttlByKey`
(`primaryKey → expiresAt` for O(1) lookup/cleanup). `_remove()` atomically
clears TTL entries. Background sweep via `startTTLSweep()` with configurable
interval. Public API: `setTTL`, `getTTL`, `clearTTL`, `sweepExpiredTTL`.
Transaction support via `txn.setTTL()` / `txn.clearTTL()`. HTTP endpoints:
`GET/PUT/DELETE /api/:env/type/:type/item/:key/ttl`, `POST /api/:env/ttl/sweep`.

### E3. Retained event log (audit trail mode)

**Problem:** Deduplication erases history (C7).
**Enhancement:** Add an `auditLog: true` option per type that disables change-log
deduplication for that type. Write entries to a separate `type:T:audit` sub-database
keyed by `clock` only (no tombstoning). Consumers can then replay the full write
history. Useful for event-sourced types.

### E4. Persistent HNSW checkpoints

**Problem:** HNSW graph rebuilt from scratch on every restart (C5).
**Enhancement:** `hnswlib-node` supports `saveIndex(path)` / `loadIndex(path)`.
Serialize the graph to a file (or LMDB value) after each flush. On restart, load
the checkpoint and replay only changes since the checkpoint clock. Eliminates
potentially multi-minute rebuild times for large corpora.

### E5. Query planner with index scoring

**Problem:** No cost-based index selection (C8).
**Enhancement:** At query time, inspect `options.index` hints and available
indexes. Score candidate indexes by estimated selectivity (derived from index
cardinality metadata already stored per-index). Select the most selective index
automatically. This is feasible because LMDB stores page-count stats per sub-DB
(`db.getStats()`) which provide rough cardinality.

### E6. Multi-writer coordination via advisory lock

**Problem:** Multiple processes opening the same OKDB path can silently conflict (C1).
**Enhancement:** On `open()`, attempt to acquire an advisory file lock (`fs.open`
with exclusive flag on a `.lock` file). If acquired, this process is the primary
writer. Others open in read-only mode and receive clock updates via the bus. This
makes the multi-process safety contract explicit and machine-enforceable.

### E7. Streaming cursor backpressure

**Problem:** No backpressure on event emission (C9).
**Enhancement:** Wrap `EventEmitter` with an async-aware dispatcher for high-
frequency events (`item:create`, `system:clock_change`). When a listener is async,
collect it into a microtask queue and drain sequentially. Alternatively, expose a
`okdb.subscribe(type, asyncHandler)` API that serializes delivery per subscriber.

### E8. Schema validation on write — ✅ IMPLEMENTED

**Status:** Implemented via `env.setSchema(type, jsonSchema, { enforce })`.
JSON Schema validation runs inside `_write()` before mutation. Enforce mode
throws `OKDBSchemaError`; non-enforce mode records violations in `~schema_violations`.
Synced writes always land and record violations. See `okdb-schema-validator.js`.

**Companion feature — Foreign keys (ref constraints):** Also implemented.
`ref` annotations in JSON Schema properties declare referential integrity
constraints with `onDelete` cascade rules (`cascade`, `set_null`, `restrict`,
`no_action`). See section 3.3b for full details.

### E9. Transactional type and index operations

**Problem:** `registerType` / `registerIndex` each open their own internal
transaction, making it impossible to atomically create a type and populate it as
part of a single user transaction.
**Enhancement:** Expose `txn.registerType(type)` and `txn.registerIndex(type, parts)`
on `OKDBTransaction` so schema changes and data writes can be batched atomically.

### E10. Change log compaction

**Problem:** As the `clockToChangeDb` grows unboundedly, range scans become
slower. Currently no compaction mechanism exists.
**Enhancement:** Add `okdb.compact(beforeClock)` that removes all clock entries
older than `beforeClock` from both global and per-type change DBs, after
checkpointing all live data. Can be gated behind a configurable retention window.
Useful for long-running deployments.

### E11. Read replicas via LMDB `MDB_RDONLY`

**Problem:** Reads contend with writes for LMDB page cache in high-throughput
scenarios.
**Enhancement:** Expose a `okdb.openReadReplica(path)` factory that opens the
same LMDB environment in `MDB_RDONLY` mode. Read-only handles can serve queries
without ever blocking on write transactions. Combined with the bus poke mechanism,
replicas can invalidate in-process caches on clock change.

---

## 13. Data Flow Summary

```
User code
  │  txn.put('users', 'alice', { name: 'Alice' })
  │  await txn.commit()
  │
  ▼
okdb.db.transaction(cb)          ← LMDB write transaction begins
  │
  ├─ _validateSchema(...)        ← JSON Schema validation (if schema set)
  ├─ _checkForeignKeys(...)      ← ref constraint validation (if refs declared)
  ├─ _checkUniqueConstraints(...)← unique index validation (if unique indexes)
  ├─ db.put(key, value, version) ← primary data written
  ├─ _updateRefIndex(...)        ← reverse ref index updated (old entries removed, new added)
  ├─ _updateItemIndexes(...)     ← all secondary indexes updated
  ├─ _logChange(...)             ← clock++, global+per-type change DBs written
  │
  └─ LMDB commit                 ← fsync — single durable write
       │
       ▼
  .committed.then(...)
       │
       ├─ events.emit('item:create', ...)
       ├─ events.emit('system:clock_change', ...)
       ├─ events.emit('system:clock_change@users')
       └─ bus.emit('bus:poke', 'users')  ← UDP multicast to LAN peers
```

**Delete path additions (when refs exist):**

```
_remove(type, key, ...)
  │
  ├─ _processDeleteCascade(...)  ← prefix-scan __ref_index for incoming refs
  │    ├─ restrict → throw OKDBForeignKeyDeleteError (local only)
  │    ├─ cascade  → recursive _remove() with cycle detection
  │    └─ set_null → _write() with ref field set to null
  │
  ├─ _removeRefIndexEntries(...) ← clear outgoing ref index entries for this doc
  ├─ db.remove(key)              ← primary data removed
  ├─ _clearRefViolationsForKey(...)  ← clear any violation records for this key
  └─ _logChange(...)             ← clock++, change DBs written
```

Everything between "LMDB write transaction begins" and "LMDB commit" is
synchronous and atomic. No partial state is ever observable.

---

## 14. Quick-Reference: Files

| File                                         | Role                                                     |
| -------------------------------------------- | -------------------------------------------------------- |
| `okdb.js`                                    | Core class, all read/write/index/change-log logic        |
| `okdb-env.js`                                | Per-environment data layer: CRUD, schema, FK, violations |
| `okdb-transaction.js`                        | Batch transaction accumulator and executor               |
| `okdb-enums.js`                              | `CHANGE_ACTIONS`, `EVENTS`, `INDEX_STATE`, `OKDB_STATE`  |
| `okdb-error.js`                              | Typed error hierarchy                                    |
| `okdb-schema-validator.js`                   | JSON Schema compilation and validation                   |
| `okdb-schema-http.js`                        | HTTP routes for schema/violations/ref-violations         |
| `okdb-http.js`                               | Internal route dispatcher + optional HTTP server         |
| `okdb-bus.js`                                | UDP multicast poke bus                                   |
| `okdb-meta.js`                               | Read-only schema introspection                           |
| `okdb-migrate.js`                            | Export/import                                            |
| `okdb-plugins.js`                            | Plugin lifecycle manager                                 |
| `okdb-logger.js`                             | Pino wrapper                                             |
| `src/features/sync/okdb-sync.js`             | LWW multi-node sync                                      |
| `src/features/queue/okdb-queue.js`           | Durable job queue                                        |
| `src/features/embeddings/okdb-embeddings.js` | Vector pipeline orchestrator                             |
| `src/features/engines/okdb-engines.js`       | Persistent named service manager                         |
| `src/features/api/okdb-api.js`               | REST CRUD + changelog endpoints                          |
| `src/features/admin/okdb-admin.js`           | Admin UI backend                                         |
| `search/okdb-search.js`                      | Pluggable search framework                               |
| `search/okdb-search-engine.js`               | Search engine lifecycle + clock subscription             |
| `okdb-benchmark-suite.js`                    | 8-test performance + integrity benchmark suite           |
