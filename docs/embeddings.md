# Embeddings

OKDB has a built-in vector embedding pipeline. Point it at a type, tell it which field to embed and which ML model to use, and it handles the rest: watching the change log, calling the embedder, storing vectors, and serving nearest-neighbour queries.

---

## Concepts

| Component         | Role                                                  |
| ----------------- | ----------------------------------------------------- |
| **Embedder**      | Connection to an ML model (Ollama, OpenAI, or custom) |
| **Indexer**       | Watches a type's change log, embeds changed docs      |
| **Vector store**  | Persists `Float32Array` vectors in LMDB               |
| **Search engine** | In-memory HNSW graph for nearest-neighbour queries    |

These are wired together as **named engines** — persistent service instances whose config lives in OKDB and survive restarts.

Embeddings is now also a **built-in pipeline family** on top of the generic `~pipelines` feature:

- `okdb.embeddings.createPipeline(...)` still provides the specialized one-call setup
- the created topology is also persisted as an env-local generic pipeline record
- the generic record stores explicit ordered member roles (`embedder`, `indexer`, optional `worker`, `search`)
- embeddings HTTP/admin views read those generic records first and only fall back to legacy engine grouping for older pipelines
- starter templates now exist too: `GET /api/pipelines/templates` exposes recommended embeddings pipeline blueprints such as `embeddings-inline-fake`, `embeddings-inline-ollama`, `embeddings-queue-fake`, and `embeddings-queue-ollama`
- MCP clients can discover and expand those blueprints through `okdb_pipeline` actions `template_list`, `template_get`, `template_preview`, and `template_create`

---

## Quick start with `createPipeline`

The one-call setup that provisions all four components:

```javascript
await okdb.embeddings.createPipeline('articles', {
    source_type: 'articles', // the OKDB type to watch
    field: 'body', // which field to embed (null = stringify whole record)
    dims: 1024, // embedding dimensions (must match model)
    embedder: {
        type: 'ollama',
        model: 'mxbai-embed-large',
        url: 'http://localhost:11434',
    },
});
```

After this call, any `put` to `articles` will automatically trigger embedding. Vectors are stored in the `~default:emb:articles` environment.

The specialized embeddings facade now also writes a generic `~pipelines` record in the source environment. By default:

- the generic pipeline record name is the pipeline `storage_key`
- `meta.label` preserves the user-facing embeddings pipeline label
- `meta.family === 'embeddings'` marks the record as embeddings-backed

So a call like:

```javascript
await okdb.embeddings.createPipeline('articles-body-pipeline', {
    source_env: 'default',
    source_type: 'articles',
    storage_key: 'articles-body',
    field: 'body',
    dims: 768,
    embedder: { type: 'ollama', model: 'mxbai-embed-large' },
});
```

creates engines plus a generic pipeline record named `articles-body` in `default/~pipelines`.

This `storage_key` behavior matters when you use the new template registry too:

- the starter input usually asks for a human-facing `name`
- embeddings template plans default `storage_key` to that same `name`
- if you override `storage_key`, the persisted generic pipeline record is stored under that value instead
- `meta.label` still keeps the original display label so admin/MCP clients can show a friendly name

---

## Templates and discovery

Embeddings templates are presets for the same underlying `okdb.embeddings.createPipeline(...)` flow.

You can discover them over HTTP:

```text
GET  /api/pipelines/templates
GET  /api/pipelines/templates/:template
POST /api/pipelines/templates/:template/preview
POST /api/env/:env/pipelines/templates/:template/create
```

Built-in recommended embeddings pipeline starters currently include:

- `embeddings-inline-fake`
- `embeddings-inline-ollama`
- `embeddings-queue-fake`
- `embeddings-queue-ollama`

The preview route expands one of those starters into the exact `embeddings-create` plan it would execute, including the derived `storage_key`, `mode`, search `algorithm`, and provider config.

`POST /api/env/:env/pipelines/templates/:template/create` then executes that plan by calling the specialized embeddings facade and returning the resulting generic pipeline record.

If you want to build the pieces separately, the shared engine template registry also exposes direct embeddings engine starters through the engine API:

```text
GET  /api/engines/types
GET  /api/engines/templates
GET  /api/engines/templates/:template
POST /api/engines/templates/:template/preview
POST /api/env/:env/engines/templates/:template/create
```

That shared registry includes starter definitions such as:

- `embedder-fake`, `embedder-ollama`, `embedder-openai`
- `indexer-inline`, `indexer-queue`
- `vector-search-flat`, `vector-search-hnsw`
- `embed-worker-basic`

So the usual choice is:

- use pipeline templates when you want the full recommended embeddings topology in one step
- use engine templates when you want to compose or manage the embeddings engines individually

### MCP discovery and creation

Embeddings-related MCP behavior is now split across three grouped tools:

- `okdb_pipeline` — use `template_list`, `template_get`, `template_preview`, and `template_create` for full embeddings pipeline starters
- `okdb_engine` — use `types`, `templates`, `template_get`, `template_preview`, and `template_create` for direct engine discovery and creation
- `okdb_embeddings` — use `providers`, `models`, `models_by_provider`, `algorithms`, `probe_ollama_models`, and `embedder_models` to inspect provider schemas and model catalogs before choosing a template or creating engines manually

This makes it possible for MCP clients to both discover recommendations and actually execute them, rather than relying on out-of-band docs.

---

## Built-in embedder types

### Ollama (local)

```javascript
const embedder = {
    type: 'ollama',
    model: 'mxbai-embed-large', // or 'nomic-embed-text', etc.
    url: 'http://localhost:11434',
};
```

Requires [Ollama](https://ollama.ai) running locally:

```bash
ollama pull mxbai-embed-large
```

### OpenAI (and compatible APIs)

```javascript
const embedder = {
    type: 'openai',
    model: 'text-embedding-3-small',
    api_key: process.env.OPENAI_API_KEY,
    // base_url: 'https://api.openai.com/v1'  (default)
};
```

### Custom / fake

For development and testing without a real ML service:

```javascript
okdb.embeddings.registerEmbedderFactory('my-embedder', (config) => ({
    async embed(input) {
        // Return a Float32Array of `config.dims` dimensions
        return new Float32Array(config.dims).fill(0.5);
    },
    // Optional: one provider request for many inputs (the built-in openai and
    // ollama embedders implement it). Without it, batches fan out 4 at a time.
    async embedBatch(texts) {
        return texts.map(() => new Float32Array(config.dims).fill(0.5));
    },
    async health() {
        return { ok: true };
    },
}));

// Then use it in a pipeline:
await okdb.embeddings.createPipeline('articles', {
    source_type: 'articles',
    dims: 128,
    embedder: { type: 'my-embedder' },
});
```

### Wrapping a built-in provider

`okdb.embeddings.getEmbedderFactory(type)` returns the factory registered for an embedder
type — a built-in (`'ollama'`, `'openai'`, …) or one you registered — or `null`. Use it to
wrap a provider instead of re-implementing it, e.g. to supply the API key at runtime rather
than storing it in the pipeline's durable config:

```javascript
const openai = okdb.embeddings.getEmbedderFactory('openai');
okdb.embeddings.registerEmbedderFactory(
    'openai-vault',
    (config, db) => openai({ ...config, api_key: vault.get('openai') }, db),
    okdb.embeddings.getEmbedderSchema('openai') ?? {},
);

await okdb.embeddings.createPipeline('articles', {
    source_type: 'articles',
    dims: 1536,
    embedder: { type: 'openai-vault', model: 'text-embedding-3-small' },
});
```

Register wrappers before `okdb.open()` (like any factory) so pipelines restored at open find
them. `getEmbedderSchema(type)` returns the provider's `{ label, fields, note }` schema, or `null`.

---

## Semantic search

`createPipeline` returns a pipeline object. Use `pipeline.api.search()` to run nearest-neighbour queries:

```javascript
const pipeline = await okdb.embeddings.createPipeline('articles', {
    source_type: 'articles',
    field: 'body',
    dims: 1024,
    embedder: { type: 'ollama', model: 'mxbai-embed-large' },
});

// Text query — the pipeline embeds it then finds nearest neighbours
const results = await pipeline.api.search('database performance tuning', { limit: 5 });
for (const { key, score } of results) {
    console.log(key, score.toFixed(4));
}

// Float32Array query — skip the embed step
const vec = new Float32Array(1024).fill(0.1);
const results2 = await pipeline.api.search(vec, { limit: 10, threshold: 0.7 });
```

### Search options

| Option      | Default | Description                    |
| ----------- | ------- | ------------------------------ |
| `limit`     | 10      | Maximum results                |
| `threshold` | 0       | Minimum similarity score (0–1) |

### Chunk hits vs documents

For a chunked pipeline (`chunk: { strategy }`), each chunk is its own vector, keyed
`docKey\tchunkHash` (decode with `parseVecKey` from `okdb-chunker`). Search surfaces differ in
what they return:

| Surface                                                                      | Returns                                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `pipeline.api.search()` / `okdb.embeddings.search(name).search()`            | **Chunks** — raw vec keys, several per doc; `limit` counts chunks                                   |
| `pipeline.api.searchDocs()` / `okdb.embeddings.searchDocs(name, q, opts)`    | **Documents** — `{ key, score, chunkHash? }`, best chunk per doc; `limit` counts docs               |
| `env.query(type, filter, { vector })` (and hybrid `{ fts, vector }`)         | **Documents** — plus `vectorScore`, `chunkHash`, `chunk: { start, end }`                            |
| `POST …/pipelines/:pipeline/query`                                           | **Documents** with `value`, `chunkHash`, `chunk: { start, end, text }`; `chunks: true` → raw chunks |
| `POST …/pipelines/:pipeline/nearest` (raw vector)                            | **Chunks** — raw vec keys                                                                           |
| `POST /api/env/:env/type/:type/query` with `options.vectorSearch` / `vector` | **Documents**                                                                                       |

`searchDocs` over-fetches chunk hits until `limit` distinct documents are found (or the index is
exhausted). Unchunked pipelines return the same rows from every surface.

### Search views, memory and multiple processes

Search is a per-process **view**: the first search in a process loads an in-memory index over the
pipeline's stored vectors, a change-feed tail keeps it current, and it unloads after
`algorithm_config.idleEvictMs` without a search (default 5 min; `0` keeps it resident; env
`OKDB_VECTOR_VIEW_IDLE_EVICT_MS`). Unloading is always safe: a load starts from the newest
snapshot and reconciles it against the stored vectors, so a view never serves a graph that is
missing something that was written while it was unloaded, before a crash, or by another process.

`usearch` shares one graph per store between processes: the process holding `WRITER.LOCK` owns
the mutable graph and publishes snapshots; the others memory-map the newest snapshot read-only and
re-attach when a newer one appears. When the writer unloads or dies, a reader takes over on its
next write or search. `hnsw` keeps a private graph per process (snapshots are only a warm start);
`flat` loads straight from the stored vectors.

| `algorithm_config` (usearch) | Default | Description                                                                                                                                                                                             |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshotMaxLagMs`           | 10 000  | A reader lags the writer by at most this much: the writer publishes once its oldest unpublished change is this old (stretched to 10× the last publish's duration for very large indexes). `0` disables. |
| `snapshotEveryChanges`       | 50 000  | Also publish after this many changes (a cap for write bursts).                                                                                                                                          |
| `idleEvictMs`                | 300 000 | Unload the view after this long without a search; `0` = never.                                                                                                                                          |

A publish rewrites the whole index file, so these trade reader freshness against disk writes; the
defaults suit indexes from a few thousand to a few million vectors.

---

## Pipeline modes

### Inline (default)

The indexer calls the embedder directly inside its change-log processor drain (a background, leased `single` processor — never on the write path). Simple, no extra infrastructure:

```javascript
await okdb.embeddings.createPipeline('articles', {
    source_type: 'articles',
    field: 'body',
    dims: 1024,
    mode: 'inline', // default
    embedder: { type: 'ollama', model: 'mxbai-embed-large' },
});
```

### Queue mode

For high-throughput or external embedder services, the indexer enqueues jobs and queue consumers (the `embed-worker`, a [queue](queue.md) consumer) claim and process them concurrently across whatever nodes run the embeddings engine:

```javascript
await okdb.embeddings.createPipeline('articles', {
    source_type: 'articles',
    field: 'body',
    dims: 1024,
    mode: 'queue',
    embedder: { type: 'openai', model: 'text-embedding-3-small', api_key: '...' },
    worker: {
        concurrency: 4,
        pollInterval: 500,
        ttl: 30_000,
    },
});
```

A queue job is a reference — its payload is `{ key }` and nothing else. The worker reads the document as it is when the job runs, so a job can never embed stale text, and no document text is copied into the queue. Completed jobs are deleted on the spot. Several writes to one document while its job is still pending fold into that one job; set `debounce` (ms) to hold jobs back briefly so an edit burst costs one embed of the final text.

Queue-mode embeddings records keep the same explicit membership order in the generic pipeline registry, with the worker inserted between the indexer and search members.

---

## What gets embedded (and what doesn't)

Every document is reconciled against the vectors actually stored for it: the text is prepared and chunked, each chunk is identified by a content hash, and only hashes with no stored vector are embedded. Vectors for chunks the document no longer has are deleted. Consequences:

- **Editing a field the pipeline doesn't embed costs nothing** — no embed call, no write.
- **Editing part of a document** re-embeds only the chunks whose text changed (for `fixed` chunking, an insertion shifts every later window, so prefer `sentence`/`paragraph` for frequently edited text).
- **Retries resume**: vectors that landed before a failure are kept and skipped next time.
- **Requests are batched**: texts are sent `batch` at a time (default 32), across documents in inline mode.
- **Identical chunks across documents** (boilerplate) embed once per process while they stay in a bounded LRU (`cache`, default 1024 entries; `0` disables).
- **App registrations missing in a process hold the work, never fail it.** Custom preparers (`registerPreparer`), chunk strategies (`registerChunkStrategy`) and embedder factories (`registerEmbedderFactory`) are code, so every process that runs engines/processors on the store must register them. A process that lacks one — or whose embedder engine is not running — leaves the doc `pending`: the inline drain is held (and hands its lease to a peer that wants it), a queue job is re-queued without using a try, and `indexer.stats().waiting` reports `{ reason: 'REGISTRATION_MISSING', kind: 'preparer' | 'chunk_strategy', name }` or `{ reason: 'EMBEDDER_NOT_RUNNING' }` (plus a warning in the log). The work completes once the registration arrives in that process or a process that has it picks it up. okdb can't tell a misspelled built-in name from one registered elsewhere, so a typo holds too — the `waiting.error` message lists the built-ins. Docs marked `failed` for this reason by earlier versions stay failed until `indexer.retryFailed()` (HTTP: `POST /api/env/:env/type/:type/pipelines/:pipeline/retry-failed`).

| Option            | Default | Description                                                                  |
| ----------------- | ------- | ---------------------------------------------------------------------------- |
| `batch`           | 32      | Texts per embedder request                                                   |
| `cache`           | 1024    | Hash → vector LRU entries                                                    |
| `debounce`        | 0       | Queue mode: ms a job waits before it can be claimed (coalesces)              |
| `flushQuantum`    | 32      | Changes per indexer live-drain quantum (smaller = shorter hold of the drain) |
| `drainDeadlineMs` | 600000  | Deadline for one indexer drain quantum before it is failed and retried       |

---

## Waiting for indexing to complete

```javascript
// For a pipeline named 'articles' in the default env, the scoped key is 'default:articles'
const indexer = okdb.embeddings.indexer('default:articles');
const stats = await indexer.stats();
// { doc_counts: { pending, done, failed, total }, ... }

// Pipeline api.stats() wraps all four components
const { api } = await okdb.embeddings.createPipeline('articles', { ... });
const allStats = await api.stats();
// { embedder: {...}, indexer: {...}, worker: {...}, search: {...} }

// Wait for the indexer to finish processing all documents
function waitForIdle(pipelineKey, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        const check = async () => {
            const api = okdb.embeddings.indexer(pipelineKey);
            if (!api) return;
            const { doc_counts } = await api.stats().catch(() => ({ doc_counts: { pending: 1 } }));
            if (doc_counts.pending === 0) { clearTimeout(timer); resolve(); }
        };
        okdb.events.on(`embeddings:indexer_flushed@indexer@${pipelineKey}`, check);
        check();
    });
}

await waitForIdle('default:articles');
```

`api.flush({ timeoutMs })` (and `indexer.flush()`) waits for the indexer's change cursor to reach the source type's head (inline mode: the changes are embedded; queue mode: their jobs are enqueued, embedding follows). It rejects with `INDEXER_FLUSH_TIMEOUT` (`details: { cursor, head, timeoutMs, waiting }`) if the cursor hasn't caught up within `timeoutMs` (default 30 s) — e.g. a held pipeline or a stalled embedder.

---

## Engines

Pipelines are built on top of the **engines** feature — a generic lifecycle manager for named, persistent services. Each component (embedder, indexer, search, worker) is an engine with a type, name, config, and status stored in `~engines`.

They survive restarts: on `okdb.open()`, all previously-created engines are restored and their `start` methods called.

```javascript
// List all running engines
const engines = okdb.engines.list();
// [{ name, type, status, config, meta }, ...]

// Get a specific engine
const embedder = okdb.engines.getEngine('embedder', 'articles');
```

### Embedder scope and lifecycle behavior

Embedders are **env-local**: each environment owns its embedders (and their provider keys), the same way it owns the indexer/search/worker engines. `createPipeline` names the embedder `<env>:<name>` and stores its record in the pipeline's env — several pipelines _within the same env_ can share one embedder by referencing the same name.

Legacy stores that created embedders in `~system` (pre env-local) are migrated automatically on open: a record referenced from one env moves into it as-is; a record shared by several envs is duplicated into each of them under an env-scoped name (with the referencing indexer/search configs and pipeline member refs re-pointed); orphans are homed in `default`. The applied migrations are visible at `GET /api/system/storage` and in the admin System → Storage Format card.

Because an embedder may be shared by several pipelines in its env, embeddings-backed pipeline records mark the embedder role as lifecycle-skipped. Pipeline `start` / `stop` operations:

- manage the `indexer`, `search`, and optional `worker` members
- do **not** stop or restart the embedder just because one pipeline is paused
- on pipeline delete, remove the embedder together with the pipeline **unless** another pipeline record in the env still references it

### Changing embedder configuration

Embedder config (provider `type`, `model`, `api_key`, `url`, …) is editable after creation: `PATCH /api/embeddings/engines/embedder@<name>` with a `config` body (or `engine.patchDeclaration({ config })`) — the engine restarts automatically. Secret values echoed back as `***` keep their stored value; changing the provider `type` replaces the config wholesale. Changing model/dims invalidates existing vectors — rebuild dependent pipelines afterwards (`POST /api/env/:env/pipelines/:name/rebuild`), or swap a pipeline to another embedder with `POST /api/env/:env/pipelines/:name/replace-member` (`{ role: 'embedder', engine: '<name>' }`; dims must match the stored vectors).

### Stale pipelines (embedder model changed)

Vectors from two models are not comparable, even at the same dims, and a chunk is only re-embedded
when its _text_ changes — so okdb records which embedder produced a pipeline's vectors: the
**fingerprint** `{ type, model, dims }` (provider, model id, explicit `dims`) is stored next to the
vectors (`vec_space` row in `~<env>:emb:<type>`, replicated and dropped with them). When the
pipeline's embedder no longer matches it — the embedder's `type`/`model`/`dims` was patched,
`replaceMember`/the indexer's `embedder` field points at another embedder, or the change arrived by
sync — the pipeline is **stale**:

- `indexer(name).stats().vector_space` / `embeddings.vectorSpace(name)` →
  `{ fingerprint, current, stale: true, reason }`; `env.pipelines.get(name)` has `stale: true` and
  `vector_space`; the admin pipeline card shows a **needs re-embed** badge.
- **New embeds are held, never mixed**: the indexer's drain parks with
  `stats().waiting.reason === 'EMBEDDER_CHANGED'` (queue mode queues no new jobs; already-queued
  jobs are re-queued without consuming a try). Deletes still apply.
- **Search keeps working** on the old vectors — degraded, since queries are embedded with the new
  model. `POST …/pipelines/:pipeline/query` and `…/nearest` return the hits with
  `meta.stale: true` + `meta.warning`; `searchDocs` logs one warning per stale episode.
- **Re-embed all** (`env.pipelines.rebuild(name)`, `POST /api/env/:env/pipelines/:name/rebuild`, the
  admin "⟳ Re-embed all" button) drops the vectors and the fingerprint and re-embeds every document
  with the current embedder, which clears the stale state. Changing the embedder back to the
  recorded fingerprint also clears it (the held drain resumes on the embedder's restart).

A patch that leaves the fingerprint unchanged (same provider/model/dims — e.g. a new `api_key`,
`url` or `timeout`, or a no-op) changes nothing. okdb does not re-embed automatically: re-embedding
a corpus costs provider calls and time, so it stays an explicit rebuild. Stores from before this
change adopt the configured embedder's fingerprint on their first embed.

---

## Storage layout

```
~default:emb:articles/
  vec:<storage_key>           ← one row per doc (or per doc × chunk: "docKey\tchunkHash")
  doc_status:<storage_key>    ← one row per doc: { status, version, hash | chunks[{hash,start,end}], error? }

~system/
  ~emb:models                 ← model catalog (shared)
```

Vectors are stored as raw float32 bytes (4 bytes per dimension). Read them with `okdb.embeddings.getVector()` — a raw `vec:` row is a byte buffer, not a number array (stores written before 2.3 hold number arrays; both decode). Chunk text is never stored: search results derive it from the current source document. Deleting a source document deletes its vectors and its `doc_status` row. A search graph is loaded from its newest snapshot and reconciled against the stored vectors on each load (see "Search views" above).

### Upgrading from 2.2.x

The first open with okdb 2.3 runs storage migration `embeddings-lean-layout`: it drops the old per-pipeline bookkeeping (`doc_status`, `chunk_status`, queued embedding jobs) and lets each indexer rebuild it from the stored vectors. Chunked pipelines rebuild with no embed calls and search keeps serving throughout; unchunked documents are re-embedded once. Set `OKDB_EMBEDDINGS_REEMBED=1` for that first open to drop the vectors too and re-embed everything. After the migration, okdb 2.2.x refuses to open the store.

:::note
Vector data (the raw Float32Array values stored in `vec:` types) **is replicated** via the normal change log — embedding is expensive, so every node receives the computed vectors automatically. Each node's search graph is reconciled locally against these synced vectors on every load.
:::
