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

---

## Pipeline modes

### Inline (default)

The indexer calls the embedder synchronously in the change-log processor. Simple, no extra infrastructure:

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

Queue-mode embeddings records keep the same explicit membership order in the generic pipeline registry, with the worker inserted between the indexer and search members.

---

## Waiting for indexing to complete

```javascript
// For a pipeline named 'articles' in the default env, the scoped key is 'default:articles'
const indexer = okdb.embeddings.indexer('default:articles');
const stats = await indexer.stats();
// { doc_counts: { pending, done, failed, deleted, total }, ... }

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

---

## Storage layout

```
~default:emb:articles/
  vec:<storage_key>           ← Float32Array vectors in LMDB
  doc_status:<storage_key>    ← per-document embedding status

~system/
  ~emb:models                 ← model catalog (shared)
```

The vector store persists raw `Float32Array` bytes (not JSON), preserving full floating-point precision. The HNSW graph is rebuilt from these stored vectors on each restart.

:::note
Vector data (the raw Float32Array values stored in `vec:` types) **is replicated** via the normal change log — embedding is expensive, so every node receives the computed vectors automatically. The in-memory HNSW search graph is rebuilt locally from these synced vectors on each restart.
:::
