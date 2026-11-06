# Data Model

## Types

A **type** is a named collection of records — similar to a table in SQL or a collection in MongoDB.

```javascript
await okdb.registerType('articles');
```

Each type gets its own set of LMDB sub-databases: one for data and one for each secondary index. All sub-databases live inside the same LMDB environment (directory) and participate in the same transactions. FTS data is stored in a separate shared LMDB environment pair (see [Storage layout](#storage-layout)).

### Type operations

```javascript
// Register (throws if already exists)
await okdb.registerType('articles');

// Idempotent register + index setup
await okdb.ensureType('articles', {
    indexes: [['author'], ['author', 'publishedAt'], { fields: ['location'], type: 'geo' }],
});

// Check existence
okdb.hasType('articles'); // → boolean

// Drop (deletes all records, indexes, and sub-databases)
await okdb.dropType('articles');
```

---

## Records

A **record** is a key-value pair inside a type.

- **Key**: a string (your choice — UUID, slug, user ID, etc.)
- **Value**: any JSON-serialisable value

```javascript
await okdb.registerType('articles');
await okdb.put('articles', 'how-lmdb-works', {
    title: 'How LMDB works',
    author: 'alice',
    body: '...',
    publishedAt: Date.now(),
    tags: ['database', 'internals'],
});
```

Values can also be direct JSON scalars or arrays (`"hello"`, `42`, `true`, `null`, `[]`). Those values are stored and read back normally. However, object-oriented features such as `patch()` and observed field schema only apply to plain object records.

Values are encoded with msgpack and LZ4-compressed above a small size threshold (`compression: true` by default). Keys and secondary-index keys use the [ordered-binary](https://github.com/DoctorEvidence/ordered-binary) encoding, which preserves type ordering in scans.

### Versions

Every record implicitly has a **version** — an integer that monotonically increases with each write. It is stored with the record and drives optimistic concurrency (`ifVersion`, see [Transactions](./transactions.md#optimistic-concurrency)).

<!-- continues -->

```javascript
const entry = okdb.getEntry('articles', 'how-lmdb-works');
// entry = { value: {...}, version: 1 }
```

---

## Environments

An **environment** is an isolated LMDB directory. OKDB opens several by default and you can create more.

### Built-in environments

| Name                         | Purpose                                                 | Synced |
| ---------------------------- | ------------------------------------------------------- | ------ |
| `~system`                    | Node identity, env registry                             | yes    |
| `default`                    | Your types and data                                     | yes    |
| `~<env>:emb:<type>`          | Per-type embedding vectors                              | yes    |
| `~log`, `~processes`, `~sub` | Node-local log, process registry, subscription sessions | no     |

:::note
`queue` and `files` live inside each environment — each env has its own queue and file store.
:::

### Creating custom environments

```javascript
// Create a new named environment (idempotent — returns the open env if it exists).
// Optional per-env config: durability, lmdb, compression, encryptionKey.
const analyticsEnv = await okdb.createEnvironment('analytics');

// It has the same API as okdb itself
await analyticsEnv.registerType('events');
await analyticsEnv.put('events', 'e1', { action: 'click', ts: Date.now() });
const evt = analyticsEnv.get('events', 'e1');
```

Accessing an environment:

```javascript
await okdb.createEnvironment('analytics');

okdb.env('default'); // the default env
okdb.env('analytics'); // custom env by name
okdb.default; // shorthand for okdb.env('default')
```

### When to use multiple environments

- Separate high-churn data from user data (e.g. analytics events vs. user records)
- Independent encryption keys per dataset (`createEnvironment(name, { encryptionKey })`)
- Physical isolation for compaction or backup

Every user environment keeps a change log and takes part in sync — the old per-env `sync: false` opt-out was removed and now throws `SYNC_OPTION_REMOVED`.

---

## Storage layout

OKDB creates this structure on disk:

```
mydb/
  ~system/          ← node identity + env registry
  default/          ← your types and records
    ~blobs/         ← the env's file blobs (SHA-256 content-addressable; encrypted with the env's key)
    ~vectors/       ← the env's vector-search snapshots
    time-machine/   ← the env's field-level history
  ~log/ ~processes/ ~sub/ ← node-local internal envs
  ~<env>-emb-<type>/← per-type vector store (env `~<env>:emb:<type>`; ':' becomes '-' on disk)
  ~fts/
    <envName>/      ← shared FTS inverted index (all types + indexes in this env)
    <envName>_docs/ ← shared FTS forward index (docKey → tokens, compressed)
```

All FTS indexes across all types within the same OKDB env share a single pair of LMDB environments. Each index is differentiated by an auto-increment `ftsId` stored as a compound key prefix inside those shared environments.

Inside each LMDB environment, sub-databases are named by convention:

```
"clock"               → global monotonic integer
"types"               → type metadata (field schema, FTS config)
"changes"             → changeId → latest clock
"clocks"              → clock → change object (the event log)

per type T:
  "type:T"            → lifecycle records
  "type:T:data"       → key → value (useVersions=true)
  "type:T:index"      → index metadata
  "type:T:index:I"    → dupSort ordered-binary index entries
  "type:T:clockToChange" → clock → changeId
  "type:T:keyToChange"   → key → changeId
```

---

## Full-text search

FTS indexes are **async by default**. When a document is written, the change is recorded in the change log. A background processor picks up changes and updates the FTS index. This means:

- Writes return immediately — no FTS I/O on the write path.
- There is a short lag between a write and when the document becomes searchable.
- Use `fts.flush(type)` to wait for the processor to catch up before querying. This is useful in tests and after bulk imports.
- Use `fts.ready(type)` to wait for the initial index build to complete after registering a new index.

```javascript
await okdb.registerType('articles');

// Register an FTS index
await okdb.fts.register('articles', 'main', { fields: ['title', 'body'] });

// Wait for the initial build
await okdb.fts.ready('articles');

// Write documents
await okdb.put('articles', 'a1', { title: 'Hello world', body: 'Some content' });

// Flush processor before querying (ensures doc is indexed)
await okdb.fts.flush('articles');

// Search
const keys = okdb.fts.search('articles', 'main', 'hello');
```

### `ready(type)`

`fts.ready(type)` resolves when all FTS indexes registered on `type` have completed their initial build. The `name` parameter is accepted for backward compatibility but is ignored — readiness is per-type, not per-index.

### `flush(type)`

`fts.flush(type)` awaits the background processor catching up to the current write position, then runs the FTS compactor to roll live-tier entries into the compacted Roaring bitmap tier. Returns immediately if there's nothing to do.

### list() response

`fts.list(type)` returns an entry per registered index. Each entry includes:

- `processorState`: `'building' | 'online' | 'error' | 'waiting' | null` — `null` if no processor is running (no writes have occurred yet). Same value for every entry of the same type.
- `lag`: number of write operations the processor has not yet indexed. `0` means fully caught up. `null` if no processor.
- `sizeBytes`: approximate per-index payload (frozen blobs + live entries + forward index scoped by this index's `ftsId`). Excludes env-shared dictionaries.

### Storage architecture

FTS uses a two-tier inverted index. New writes land in a small **live** tier (LMDB dupSort) on the hot write path. A background **compactor** periodically merges live entries into the **frozen** tier — one Roaring bitmap per token. Reads merge all tiers transparently.

Documents and tokens are interned to uint32 IDs (`dict` and `tokenDict` sub-DBs) so posting lists and the forward index store compact integer arrays rather than strings.

Each registered index carries a storage `format` integer; older formats auto-rebuild on open. See [FTS](./fts.md) for the full schema and the storage-size APIs (`fts.list(type)[].sizeBytes`, `fts.envSize()`).

### Reclaiming FTS slack

LMDB never shrinks `data.mdb` in place — freed pages are reused by future writes but the file stays at its peak high-water mark. `env.compact()` reclaims that slack for both the primary env and the FTS envs in one pass. `fts.compactStorage(env)` is the FTS-only equivalent if you want to reclaim just FTS without disturbing primary storage.

---

## Field schema

OKDB observes field types as you write data and maintains a coarse schema (`string | number | boolean | null | array | object`) per field. You can inspect it:

```javascript
await okdb.ensureType('articles', { indexes: [['author'], ['author', 'publishedAt']] });
await okdb.put('articles', 'a1', { title: 'Hello', author: 'alice', publishedAt: Date.now(), tags: ['x'] });

const desc = okdb.meta.describeType('articles'); // synchronous
// {
//   type: 'articles',
//   count: 1,
//   indexes: ['author', 'author~publishedAt'],
//   fields: { title: ['string'], author: ['string'], publishedAt: ['number'], tags: ['array'] }, // every type seen per field
// }
```

The observed schema is **descriptive only** — it never rejects a write. For validation on write, declare a JSON Schema with `env.setSchema(type, schema)`; it runs inside the write (enforce mode throws, otherwise violations are recorded) and also carries foreign-key `ref` constraints.

---

## Durability modes

Set at construction time via the `durability` option (default `'balanced'`), or per environment with `createEnvironment(name, { durability })`:

| Mode       | Underlying LMDB flag | Behaviour                            | Use when                          |
| ---------- | -------------------- | ------------------------------------ | --------------------------------- |
| `strict`   | _(none)_             | Full fsync on every write            | Mission-critical, money           |
| `balanced` | `overlappingSync`    | Background sync, still safe on crash | Default; most use cases           |
| `fast`     | `noSync`             | OS controls flush timing             | Dev, caches, re-generable data    |
| `custom`   | _(see lmdb below)_   | No preset — raw `lmdb` options apply | Append-only, replicated followers |

```javascript
const okdb = new OKDB('./db', { durability: 'fast' });
await okdb.open();
await okdb.close();
```

On Linux, `strict` and `custom` also open the environment with LMDB's overlapping sync unless `noSync` is set; pass `lmdb: { overlappingSync: false }` to turn it off explicitly. `okdb.getResolvedOptions()` / `env.getResolvedOptions()` return `{ durability, lmdbOptions, warnings }` — the resolved preset plus your `lmdb` flags, and any guardrail warnings.

### Raw LMDB passthrough

For workloads like replication followers or append-only archives where you need precise control, pass LMDB flags via the `lmdb` option. The recognised flags are `noSync`, `noMetaSync`, `overlappingSync` and `useWritemap`. Use `durability: 'custom'` to disable preset interference:

```javascript
const okdb = new OKDB('./db', {
    durability: 'custom',
    lmdb: {
        noSync: true, // skip fsync — fastest, survives only clean shutdown
        noMetaSync: true, // skip metadata page fsync — partial durability improvement
    },
});
await okdb.open();
await okdb.close();
```

`noSync: true` is equivalent to `durability: 'fast'` but lets you combine it with other raw flags. `noMetaSync: true` without `noSync` is the middle ground: data pages are synced, metadata pages are not — faster than `strict`, safer than `noSync`.

OKDB enforces guardrails, checked when an environment opens:

- `noSync` or `noMetaSync` together with `durability: 'strict'` throws `UNSAFE_CONFIG`.
- `useWritemap` with `strict` or `balanced` throws `UNSAFE_CONFIG` (use `fast` or `custom`).
- `noSync` + `useWritemap` only warns (`warnings` in `getResolvedOptions()`).
- `noSync: true` with an environment that opens with overlapping sync (`balanced`, or `lmdb.overlappingSync: true`) is refused.
- An unknown `durability` value throws `INVALID_CONFIG`.

`allowUnsafe: true` downgrades the `UNSAFE_CONFIG` errors to warnings. Use `durability: 'custom'` when passing these flags explicitly.
