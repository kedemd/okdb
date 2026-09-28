// Embeddings feature — `db.embeddings` (src/features/embeddings/okdb-embeddings.js).
//
// A pipeline is four engines (embedder → indexer → [embed-worker] → vector-search) plus an
// env-local generic `~pipelines` record. Engine names are scoped `<env>:<name>`:
//   - indexer / vector-search: `<source_env>:<storage_key>`
//   - embed-worker:            `<source_env>:<storage_key>-worker` (default)
//   - embedder:                `<source_env>:<embedder name>` (env-local; legacy unscoped
//                              `~system` names still resolve)

// ── Shared ──────────────────────────────────────────────────────────────────

/** A query: text (embedded by the pipeline's embedder) or a raw vector. */
export type OKDBEmbeddingsQuery = string | Float32Array | number[];

/** Per-document indexing status (`doc_status:<storage_key>` rows). */
export type OKDBEmbeddingsDocStatus = 'pending' | 'done' | 'failed' | 'deleted';

/** Built-in preparers are `'none' | 'html' | 'markdown'`; custom ones via `registerPreparer`. */
export type OKDBEmbeddingsPreparer = 'none' | 'html' | 'markdown' | (string & {});

export interface OKDBEmbeddingsChunkConfig {
    /** `'fixed'` (default) | `'sentence'` | `'paragraph'` | `'off'` | a registered custom strategy. */
    strategy: 'fixed' | 'sentence' | 'paragraph' | 'off' | (string & {});
    /** Target chunk size in characters. Default 512. */
    size?: number;
    /** Overlap in characters (`fixed` only). Default 64. */
    overlap?: number;
}

/** One chunk produced by a chunk strategy — offsets into the prepared text. */
export interface OKDBEmbeddingsChunk {
    text: string;
    start: number;
    end: number;
}

// ── Pipelines ───────────────────────────────────────────────────────────────

export interface OKDBEmbeddingsEmbedderConfig {
    /**
     * Reuse an existing embedder by name (scoped `<env>:<name>` or a legacy unscoped one).
     * Default: the pipeline name, scoped to `source_env`.
     */
    name?: string;
    /** Provider type: `'ollama' | 'openai' | 'fake'` or a registered factory name. */
    type?: string;
    model?: string;
    dims?: number;
    /** Ollama base URL. */
    url?: string;
    /** OpenAI(-compatible) key. */
    api_key?: string;
    /** OpenAI(-compatible) base URL. */
    base_url?: string;
    /** OpenAI request timeout (ms). */
    timeout?: number;
    [key: string]: unknown;
}

export interface OKDBEmbeddingsWorkerConfig {
    /** Worker engine name. Default `<source_env>:<storage_key>-worker`. */
    name?: string;
    /** Default 1. */
    concurrency?: number;
    /** ms between empty-queue polls. Default 1000. */
    pollInterval?: number;
    /** Job claim TTL in ms. Default 30 000. */
    ttl?: number;
}

export interface OKDBEmbeddingsPipelineConfig {
    /** The OKDB type to watch. Required. */
    source_type: string;
    /** Source environment. Default `'default'`. */
    source_env?: string;
    /** Logical vector-store name and generic pipeline record name. Default: the pipeline name. */
    storage_key?: string;
    /** Field to embed; `null`/omitted = the whole record. */
    field?: string | null;
    /** Vector dimensions; default resolved from the embedder. */
    dims?: number;
    /** `'inline'` (default) embeds in the change-log drain; `'queue'` hands jobs to an embed-worker. */
    mode?: 'inline' | 'queue';
    embedder?: OKDBEmbeddingsEmbedderConfig;
    /** Queue mode only. */
    worker?: OKDBEmbeddingsWorkerConfig;
    prepare?: OKDBEmbeddingsPreparer;
    chunk?: OKDBEmbeddingsChunkConfig;
    /** Texts per embedder request. Default 32. */
    batch?: number;
    /** Hash → vector LRU entries (0 disables). Default 1024. */
    cache?: number;
    /** Queue mode: ms a job waits before it can be claimed (coalesces edit bursts). Default 0. */
    debounce?: number;
    /** Changes per indexer live-drain quantum (smaller = shorter hold of the instance's drain gate). Default 32. */
    flushQuantum?: number;
    /** Deadline in ms for one indexer drain quantum before it is failed and retried. Default 600 000. */
    drainDeadlineMs?: number;
    /** Search algorithm: `'flat'` (default) | `'hnsw'` | `'usearch'` | a registered factory. */
    algorithm?: string;
    /** Forwarded to the algorithm factory (e.g. `metric`, `M`, `efSearch`, `idleEvictMs`). */
    algorithm_config?: Record<string, unknown>;
}

/** An engine instance as returned by the engines subsystem (may be in an error state). */
export interface OKDBEmbeddingsEngine<TApi = unknown> {
    /** `<type>@<name>`. */
    readonly key: string;
    readonly type: string;
    readonly name: string;
    readonly isRunning: boolean;
    readonly status: string;
    /** The driver's runtime API (null when not running). */
    readonly api: TApi | null;
    start(): Promise<unknown>;
    stop(options?: { reason?: string }): Promise<unknown>;
    [key: string]: unknown;
}

/** `createPipeline(...).api` — convenience surface bound to one pipeline. */
export interface OKDBEmbeddingsPipelineApi {
    /** Chunk-level search (see `OKDBEmbeddings.search`). */
    search(query: OKDBEmbeddingsQuery, options?: OKDBEmbeddingsSearchOptions): Promise<OKDBEmbeddingsSearchResult[]>;
    /** Document-level search (see `OKDBEmbeddings.searchDocs`). */
    searchDocs(
        query: OKDBEmbeddingsQuery,
        options?: OKDBEmbeddingsSearchOptions,
    ): Promise<OKDBEmbeddingsDocSearchResult[]>;
    /**
     * Wait until the indexer's cursor reaches the source head clock (default bound 30 s). Rejects with
     * `INDEXER_FLUSH_TIMEOUT` (`details: { cursor, head, timeoutMs, waiting }`) if it doesn't get there in
     * time. Throws if the indexer isn't running here.
     */
    flush(options?: { timeoutMs?: number }): Promise<void>;
    /** Each member's health/stats; `undefined` for members not running in this process. */
    stats(): Promise<{
        embedder: OKDBEmbedderHealth | undefined;
        indexer: OKDBEmbeddingsIndexerStats | undefined;
        worker: OKDBEmbeddingsWorkerStats | undefined;
        search: OKDBEmbeddingsSearchStats | undefined;
    }>;
}

/** Result of `createPipeline`: the member engines plus a bound API. */
export interface OKDBEmbeddingsPipelineResult {
    embedder: OKDBEmbeddingsEngine<OKDBEmbedderApi>;
    indexer: OKDBEmbeddingsEngine<OKDBEmbeddingsIndexerApi>;
    /** `null` unless `mode: 'queue'`. */
    worker: OKDBEmbeddingsEngine<OKDBEmbeddingsWorkerApi> | null;
    search: OKDBEmbeddingsEngine<OKDBEmbeddingsSearchApi>;
    api: OKDBEmbeddingsPipelineApi;
}

/**
 * @deprecated Pipelines are no longer a record type of this class — `createPipeline` returns
 * {@link OKDBEmbeddingsPipelineResult}; the persisted topology lives in the env's generic
 * `~pipelines` registry (`env.pipelines`). Alias kept for existing imports.
 */
export type OKDBEmbeddingsPipeline = OKDBEmbeddingsPipelineResult;

// ── Engine runtime APIs ─────────────────────────────────────────────────────

export interface OKDBEmbedderHealth {
    ok: boolean;
    type: string;
    model: string | null;
    dims: number | null;
    [key: string]: unknown;
}

/** `embeddings.embedder(name)` — the running embedder engine's API. */
export interface OKDBEmbedderApi {
    /** Resolved output dimensions (null if unknown at start). */
    readonly dims: number | null;
    embed(input: string): Promise<Float32Array>;
    embed(input: string[]): Promise<Float32Array[]>;
    health(): Promise<OKDBEmbedderHealth>;
}

export interface OKDBEmbeddingsDocCounts {
    pending: number;
    done: number;
    failed: number;
    deleted: number;
    total: number;
}

/** Identifies an embedding vector space: provider, model id, explicit output dims. */
export interface OKDBEmbeddingsFingerprint {
    type: string;
    model: string | null;
    dims: number | null;
}

/**
 * Vector-space status of a pipeline. `stale`: the stored vectors were embedded by a different
 * embedder (provider/model/dims) than the one configured now — search still serves them (with a
 * warning), new embeds are held, and a rebuild ("Re-embed all") re-embeds and clears it.
 */
export interface OKDBEmbeddingsVectorSpace {
    /** Fingerprint recorded with the stored vectors (null until the first embed). */
    fingerprint: OKDBEmbeddingsFingerprint | null;
    /** Fingerprint of the embedder configured now. */
    current: OKDBEmbeddingsFingerprint | null;
    stale: boolean;
    /** Human-readable explanation, only when stale. */
    reason?: string;
}

export interface OKDBEmbeddingsIndexerStats {
    engine_key: string;
    mode: 'inline' | 'queue';
    source_type: string;
    storage_key: string;
    job_type: string | null;
    last_seen_clock: number;
    head_clock: number;
    processor_cursor: number;
    vector_count: number | null;
    doc_counts: OKDBEmbeddingsDocCounts;
    /** Live indexer only. */
    embedder?: string;
    /**
     * Live indexer only — set while work is held:
     * `{ reason: 'FIELD_RESOLVER_MISSING' | 'REGISTRATION_MISSING' | 'EMBEDDER_NOT_RUNNING' | 'EMBEDDER_CHANGED', error, since, … }`.
     */
    waiting?: Record<string, unknown> | null;
    /** Which embedder the stored vectors came from, and whether that is still the configured one. */
    vector_space?: OKDBEmbeddingsVectorSpace;
    batch?: number;
    prepare?: string;
    chunk?: OKDBEmbeddingsChunkConfig;
    /** Durable (no live indexer here) reads only. */
    remote?: true;
    enabled?: boolean;
    [key: string]: unknown;
}

/** A `doc_status` row, keyed by source doc. */
export interface OKDBEmbeddingsDocStatusEntry {
    key: string;
    source_key?: string;
    status: OKDBEmbeddingsDocStatus;
    version?: number | null;
    clock?: number | null;
    updated?: number;
    error?: string;
    empty?: boolean;
    /** Unchunked: content hash of the embedded text. */
    hash?: string;
    /** Chunked: manifest of embedded chunks. */
    chunks?: Array<{ hash: string; start: number; end: number }>;
    /** Chunked: `chunks.length`. */
    chunk_done?: number;
    [key: string]: unknown;
}

export interface OKDBEmbeddingsRetryFailedOptions {
    /** Max docs to retry (1–10 000). Default 1000. */
    limit?: number;
    /** Also retry PENDING docs whose job was lost. Default false. */
    includeStuckPending?: boolean;
}

export interface OKDBEmbeddingsRetryFailedResult {
    retried: number;
    deleted: number;
    /** Inline mode only. */
    succeeded?: number;
}

/** `embeddings.indexer(name)` — the running indexer engine's API. */
export interface OKDBEmbeddingsIndexerApi {
    /**
     * Wait for the change feed to catch up with the source type (default bound 30 s). Rejects with
     * `INDEXER_FLUSH_TIMEOUT` if it doesn't get there in time.
     */
    flush(options?: { timeoutMs?: number }): Promise<void>;
    stats(): Promise<OKDBEmbeddingsIndexerStats>;
    getDocStatus(sourceKey: string): Promise<Record<string, unknown> | null>;
    listDocStatus(options?: {
        status?: OKDBEmbeddingsDocStatus | null;
        /** 1–1000. Default 100. */
        limit?: number;
    }): Promise<OKDBEmbeddingsDocStatusEntry[]>;
    /** Bring one doc's vectors in line with its content; throws `EMBED_FAILED` if the doc ends failed. */
    reconcile(sourceKey: string, options?: { heartbeat?: () => unknown }): Promise<OKDBEmbeddingsDocStatus | undefined>;
    /** External write-back (custom workers). `vector` must be a Float32Array. */
    markDone(
        sourceKey: string,
        options?: { vector?: Float32Array; clock?: number | null; empty?: boolean },
    ): Promise<unknown>;
    markFail(sourceKey: string, error: unknown, options?: { clock?: number | null }): Promise<unknown>;
    markDelete(sourceKey: string): Promise<null>;
    /** Queue mode re-enqueues; inline mode reconciles on the spot (and reports `status`). */
    retryDoc(
        sourceKey: string,
    ): Promise<{ retried: number; source_key: string; status?: OKDBEmbeddingsDocStatus | null }>;
    retryFailed(options?: OKDBEmbeddingsRetryFailedOptions): Promise<OKDBEmbeddingsRetryFailedResult>;
    /** Generic engine retry action — alias of `retryFailed`. */
    retry(options?: OKDBEmbeddingsRetryFailedOptions): Promise<OKDBEmbeddingsRetryFailedResult>;
    /** Full re-embed: drops vectors + doc_status, resets the cursor to 0. Throws `ENGINE_NOT_RUNNING` if stopped. */
    rebuild(): Promise<{ rebuilt: true; vectorsDropped: number; statusesDropped: number }>;
}

export interface OKDBEmbeddingsWorkerStats {
    engine_key: string;
    job_type: string | null;
    indexer: string | null;
    embedder: string | null;
    concurrency: number | null;
    /** Per-process counters; `null` on durable (remote) reads. */
    processed: number | null;
    failed: number | null;
    in_flight: number | null;
    /** Durable (remote) reads only. */
    queue_depth?: unknown;
    remote?: true;
    enabled?: boolean;
}

/** `embeddings.worker(name)` — the running embed-worker engine's API. */
export interface OKDBEmbeddingsWorkerApi {
    stats(): Promise<OKDBEmbeddingsWorkerStats>;
}

export interface OKDBEmbeddingsSearchOptions {
    /** Max results. Default 10. For `searchDocs` it counts documents; otherwise chunks. */
    limit?: number;
    /** Minimum similarity score (0–1). Default 0. */
    threshold?: number;
    /** Other options are forwarded to the search algorithm. */
    [key: string]: unknown;
}

/**
 * A chunk-level hit. For chunked pipelines `key` is a vec key (`docKey\tchunkHash`,
 * decode with `parseVecKey`); otherwise the source doc key. Score ∈ [0, 1], higher = closer.
 */
export interface OKDBEmbeddingsSearchResult {
    key: string;
    score: number;
}

/** A document-level hit from `searchDocs`: best chunk per source doc. */
export interface OKDBEmbeddingsDocSearchResult {
    key: string;
    score: number;
    /** The winning chunk's hash — chunked pipelines only. */
    chunkHash?: string;
}

export interface OKDBEmbeddingsSearchStats {
    engine_key: string;
    loaded: boolean;
    count: number;
    storage_key?: string;
    dims?: number;
    algorithm?: string;
    idleEvictMs?: number;
    vector_count?: number | null;
    [key: string]: unknown;
}

/**
 * `embeddings.search(name)` — a per-process local search view. `search`/`stats` are always
 * present; the rest exist only when the vector-search engine is running in this process.
 */
export interface OKDBEmbeddingsSearchApi {
    /** Chunk-level nearest neighbours, best-first. */
    search(query: OKDBEmbeddingsQuery, options?: OKDBEmbeddingsSearchOptions): Promise<OKDBEmbeddingsSearchResult[]>;
    stats(): Promise<OKDBEmbeddingsSearchStats>;
    /** Persist a vector (Float32Array of the pipeline's dims). */
    add?(key: string, vector: Float32Array): Promise<void>;
    remove?(key: string): Promise<void>;
    /** Vectors loaded in this process's view (0 if not materialized). */
    count?(): number;
    snapshot?(): Promise<unknown>;
    rebuild?(): Promise<{ count: number }>;
}

// ── Registries / catalog ────────────────────────────────────────────────────

/** Object an embedder factory returns. */
export interface OKDBEmbedderImpl {
    /** Embed one input; return one vector. */
    embed(input: string): Promise<Float32Array | number[]>;
    /** Optional native batch (one provider request for many inputs). */
    embedBatch?(texts: string[]): Promise<Array<Float32Array | number[]>>;
    health?(): Promise<Record<string, unknown>>;
    start?(): Promise<void> | void;
    stop?(): Promise<void> | void;
    dims?: number;
    [key: string]: unknown;
}

export type OKDBEmbedderFactory = (config: Record<string, unknown>, okdb: unknown) => OKDBEmbedderImpl;

/** A UI form field descriptor for provider/algorithm schemas. */
export interface OKDBEmbeddingsSchemaField {
    key: string;
    type?: string;
    label?: string;
    [key: string]: unknown;
}

export interface OKDBEmbedderSchema {
    label: string;
    fields: OKDBEmbeddingsSchemaField[];
    note: string | null;
}

export interface OKDBEmbeddingsProvider extends OKDBEmbedderSchema {
    key: string;
}

/**
 * Returns a search algorithm instance (flat/hnsw/usearch or custom). okdb drives it through
 * `ready`, `load(getAll)`, `add`, `remove`, `search(vec, { limit, threshold, … })`,
 * `snapshot`, `rebuild(getAll)`, `count`, `info`, `stop`.
 */
export type OKDBAlgorithmFactory = (
    algorithmConfig: Record<string, unknown>,
    options: { dims: number; dir: string },
) => unknown;

export interface OKDBAlgorithmSchema {
    label?: string;
    description?: string | null;
    note?: string | null;
    fields?: OKDBEmbeddingsSchemaField[];
    /** JSON Schema for `algorithm_config`. */
    configSchema?: Record<string, unknown> | null;
}

export interface OKDBEmbeddingsAlgorithmInfo {
    key: string;
    label: string;
    description: string | null;
    note: string | null;
    fields: OKDBEmbeddingsSchemaField[];
    configSchema: Record<string, unknown> | null;
}

export interface OKDBEmbeddingsModel {
    provider: string;
    model: string;
    dims: number;
    description?: string;
    builtin?: boolean;
    [key: string]: unknown;
}

/** Custom vector storage adapter returned by a `setStorageResolver` function. */
export interface OKDBVectorStorageAdapter {
    put(key: string, vector: Float32Array): Promise<unknown> | unknown;
    remove(key: string): Promise<unknown> | unknown;
    get?(key: string): Float32Array | null;
    getAll?(): Promise<unknown[]>;
    write?(puts: unknown[], removes: string[]): Promise<unknown>;
    keys?(range?: unknown): string[];
    count?(): number;
    dropAll?(): Promise<unknown>;
    stats?(): Record<string, unknown>;
    [key: string]: unknown;
}

export type OKDBVectorStorageResolver = (storageKey: string, okdb: unknown) => OKDBVectorStorageAdapter;

export interface OKDBVectorStoreStats {
    storage_key: string;
    /** `vec:<storage_key>`. */
    type: string;
    count: number;
}

export interface OKDBEmbeddingsDurableRebuildResult {
    rebuilt: true;
    remote: true;
    /** Processor reset command epoch, or null if the desired-state store was unavailable. */
    resetEpoch: number | null;
    vectorsDropped: number;
    statusesDropped: number;
    enqueued: number;
    /** True when nothing could be enqueued here (inline mode) — a live indexer must re-embed. */
    requiresLiveEngine: boolean;
}

// ── Feature object ──────────────────────────────────────────────────────────

/**
 * `db.embeddings` — vector embedding pipelines and semantic search.
 *
 * Engine/pipeline names are env-scoped `<env>:<name>` (see file header). List/stop/remove
 * pipelines through the env's generic pipelines registry (`env.pipelines`).
 * Removed: `addPipeline`/`removePipeline`/`getPipeline`/`listPipelines`/`embed` (never existed
 * in 2.x — use `createPipeline`, `env.pipelines`, and `embedder(name).embed`).
 */
export declare class OKDBEmbeddings {
    // ── Configuration / registries — register before `db.open()` so restored pipelines find them.

    /** Register an embedder provider type (also used to wrap a built-in, see `getEmbedderFactory`). */
    registerEmbedderFactory(name: string, factory: OKDBEmbedderFactory, schema?: Partial<OKDBEmbedderSchema>): void;
    /** The factory for an embedder type (built-in `'ollama' | 'openai' | 'fake'` or registered), or null. */
    getEmbedderFactory(type: string): OKDBEmbedderFactory | null;
    /** The `{ label, fields, note }` schema registered with an embedder type, or null. */
    getEmbedderSchema(type: string): OKDBEmbedderSchema | null;
    /** Register a search algorithm (built-ins: `'flat'`, `'hnsw'`, `'usearch'`). */
    registerAlgorithmFactory(name: string, factory: OKDBAlgorithmFactory, schema?: OKDBAlgorithmSchema): void;
    listAlgorithms(): OKDBEmbeddingsAlgorithmInfo[];
    /** Custom text preparer: raw field value → string. Use as `{ prepare: name }`. */
    registerPreparer(name: string, fn: (value: unknown) => string): void;
    /** Custom chunk strategy. Use as `{ chunk: { strategy: name } }`. */
    registerChunkStrategy(
        name: string,
        fn: (text: string, options: { size: number; overlap: number }) => OKDBEmbeddingsChunk[],
    ): void;
    /** Replace the built-in LMDB vector storage (`vec:<storage_key>`); `null` restores it. */
    setStorageResolver(fn: OKDBVectorStorageResolver | null): void;

    // ── Pipelines & engines

    /**
     * Create (or repair) a full pipeline: embedder, indexer, optional queue worker, vector-search,
     * plus an env-local `~pipelines` record named `storage_key`. Rejects if a complete pipeline
     * with that `storage_key` already exists. License-gated (`embeddings`).
     */
    createPipeline(
        name: string,
        config: OKDBEmbeddingsPipelineConfig,
        meta?: Record<string, unknown>,
    ): Promise<OKDBEmbeddingsPipelineResult>;
    /**
     * Create and start an env-local embedder engine. The env comes from `envName`, `config.env`,
     * or the `<env>:` prefix of `name`; default `'default'`.
     */
    createEmbedder(
        name: string,
        config?: OKDBEmbeddingsEmbedderConfig & { env?: string },
        meta?: Record<string, unknown>,
        envName?: string | null,
    ): Promise<OKDBEmbeddingsEngine<OKDBEmbedderApi>>;
    /** Create and start an indexer engine in `config.source_env` (default `'default'`). */
    createIndexer(
        name: string,
        config: Record<string, unknown> & {
            source_type: string;
            storage_key: string;
            embedder: string;
            source_env?: string;
        },
        meta?: Record<string, unknown>,
    ): Promise<OKDBEmbeddingsEngine<OKDBEmbeddingsIndexerApi>>;
    /** Create and start a vector-search engine in `config.source_env` (default `'default'`). */
    createSearch(
        name: string,
        config: Record<string, unknown> & { storage_key: string; source_env?: string },
        meta?: Record<string, unknown>,
    ): Promise<OKDBEmbeddingsEngine<OKDBEmbeddingsSearchApi>>;
    /** Create and start an embed-worker engine in `config.source_env` (default `'default'`). */
    createWorker(
        name: string,
        config: Record<string, unknown> & { job_type: string; indexer: string; embedder: string; source_env?: string },
        meta?: Record<string, unknown>,
    ): Promise<OKDBEmbeddingsEngine<OKDBEmbeddingsWorkerApi>>;

    /** Running embedder's API in this process, or null. */
    embedder(name: string): OKDBEmbedderApi | null;
    /** Running indexer's API in this process (e.g. `'default:articles'`), or null. */
    indexer(name: string): OKDBEmbeddingsIndexerApi | null;
    /** Running embed-worker's API in this process, or null. */
    worker(name: string): OKDBEmbeddingsWorkerApi | null;

    // ── Search

    /**
     * Search API for a scoped name (`'<env>:<storage_key>'`). Works on any process: the first
     * search lazily materializes a local in-memory view over the durable vectors (its `search()`
     * rejects with `ENGINE_NOT_FOUND` if the name isn't configured). Chunk-level.
     */
    search(name: string): OKDBEmbeddingsSearchApi;
    /**
     * Document-level search: collapses chunk hits to one row per source doc (best chunk wins,
     * its `chunkHash` rides along) and over-fetches until `limit` distinct docs are found.
     * Unchunked pipelines pass straight through. Default `limit` 10. Best-first.
     */
    searchDocs(
        name: string,
        query: OKDBEmbeddingsQuery,
        options?: OKDBEmbeddingsSearchOptions,
    ): Promise<OKDBEmbeddingsDocSearchResult[]>;
    /**
     * Vector-space status of a pipeline (scoped name): which embedder the stored vectors came from
     * and whether it is still the configured one (`stale`). Null without a durable indexer record.
     */
    vectorSpace(name: string): OKDBEmbeddingsVectorSpace | null;
    /**
     * Describe one chunk of a search hit: offsets from the doc_status manifest, plus `text`
     * re-derived from `sourceValue` when given (only while the doc still contains that chunk).
     */
    describeChunk(
        name: string,
        sourceKey: string,
        chunkHash: string,
        sourceValue?: unknown,
    ): Promise<{ start: number; end: number; text?: string } | null>;

    // ── Durable (engine-less) operations — usable from a process with no live indexer (e.g.
    //    `engines:false`). Each resolves `null` when the indexer has no durable record.

    durableMarkDone(
        name: string,
        sourceKey: string,
        options?: { vector?: Float32Array; clock?: number | null },
    ): Promise<unknown>;
    durableMarkFail(
        name: string,
        sourceKey: string,
        error: unknown,
        options?: { clock?: number | null },
    ): Promise<unknown>;
    durableMarkDelete(name: string, sourceKey: string): Promise<{ source_key: string; dropped: true } | null>;
    /** Queue-mode pipelines only (null otherwise). A missing source doc is deleted instead. */
    durableRetryDoc(
        name: string,
        sourceKey: string,
    ): Promise<{ retried: number; source_key: string } | { source_key: string; dropped: true } | null>;
    /** Queue-mode pipelines only (null otherwise). */
    durableRetryFailed(
        name: string,
        options?: OKDBEmbeddingsRetryFailedOptions,
    ): Promise<{ retried: number; deleted: number } | null>;
    /**
     * "Re-embed all" without a live indexer: drops vectors + doc_status and resets the durable
     * cursor (a live owner elsewhere re-bootstraps); queue mode also enqueues every doc.
     */
    durableRebuild(name: string): Promise<OKDBEmbeddingsDurableRebuildResult | null>;

    // ── Vector stores

    /** Stats of a `vec:<storage_key>` store; null when a custom storage resolver is set. */
    vectorStoreStats(storageKey: string): OKDBVectorStoreStats | null;
    /** Vector stores opened in this process; `env` is the `~<env>:emb:<type>` env name. */
    listVectorStores(): Array<OKDBVectorStoreStats & { env: string }>;
    /** One stored vector; null if absent or a custom storage resolver is set. */
    getVector(storageKey: string, docKey: string): Float32Array | null;

    // ── Model catalog (`~system` `~emb:models`)

    /** Catalog dims for a provider/model (falls back to the base name without `:tag`), or null. */
    resolveModelDims(provider: string, model: string): number | null;
    registerModel(provider: string, model: string, dims: number, description?: string): Promise<void>;
    listModels(provider?: string | null): OKDBEmbeddingsModel[];
    /** Registered embedder provider types with their UI schemas. */
    listProviders(): OKDBEmbeddingsProvider[];
}
