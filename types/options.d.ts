// Core option types and data shapes

export type OKDBPrimaryKey = string | number;
export type OKDBIndexKey = Array<string | number | boolean | null | Buffer>;
/** A sift/MongoDB-style filter. Code-evaluating operators (`$where`) are rejected with
 *  `QUERY_OPERATOR_FORBIDDEN` everywhere a filter is accepted. */
export type OKDBFilter = Record<string, unknown>;
/** An index is named by its field list (`['customerId', 'createdAt']`) or the `~`-joined
 *  string form (`'customerId~createdAt'`). */
export type OKDBIndexSpec = string | string[];

// ── Constructor options ───────────────────────────────────────────────────────

/**
 * `new OKDB(path, options)`.
 *
 * Removed options throw at construction (see docs/upgrade-2.0.md): `asyncProcessors`
 * (ASYNC_PROCESSORS_REMOVED), `processing` (PROCESSING_REMOVED), `bus` (BUS_OPTION_REMOVED),
 * `envs` (ENVS_REMOVED), `deferProcessing` (DEFER_PROCESSING_REMOVED), `workers` (WORKERS_REMOVED),
 * `sync: true | false` (SYNC_OPTION_REMOVED — `sync` is only the settings object now),
 * `compaction: 'active' | 'passive'` (COMPACTION_ALIAS_REMOVED), `processors: '<filter>'`.
 * Any other key not listed here is ignored with one logged warning (did-you-mean for near-misses).
 */
export interface OKDBOptions {
    maxDbs?: number;
    pageSize?: number;
    compression?: boolean;
    encryptionKey?: string | Buffer;
    mapSize?: number;
    durability?: 'strict' | 'balanced' | 'fast' | 'custom';
    allowUnsafe?: boolean;
    /** Raw lmdb-js options (advanced; validated against `durability`). */
    lmdb?: Record<string, unknown>;
    auth?: OKDBAuthOptions;
    /** Sync (replication) settings for `db.sync`. */
    sync?: OKDBSyncOptions;
    /** Queue defaults applied to every env's queue. */
    queue?: OKDBQueueOptions;
    /** Function-runtime defaults. */
    functions?: Record<string, unknown>;
    /** Time machine: attached to user envs (`env.timeMachine`) only when truthy (and licensed). */
    timeMachine?: boolean | OKDBTimeMachineOptions;
    /** MCP endpoint options. */
    mcp?: { allowedOrigins?: string[] | '*' | null; [key: string]: unknown };
    /** false skips booting runtime-declared views/processors at open(). Default true. */
    runtimeDeclarations?: boolean;
    log?: { retainDays?: number; [key: string]: unknown };
    /** close() grace period in ms (default 30000). */
    shutdownTimeout?: number;
    /** Reader-table check interval in ms (default 60000, min 1000). */
    readerCheckIntervalMs?: number;
    /** Lifecycle role flag: run queue/pipeline/embeddings engines on this instance. Default true. */
    engines?: boolean;
    /** INITIAL processing participation (claim every unclaimed `single` lease and drain derived
     *  work — FTS, views, time-machine, embeddings). Default true. false = not participating:
     *  claim nothing; reads/writes + inline processors still run. Participation is dynamic —
     *  `db.processors.start()/stop()` flip it at runtime (open with false + start() later =
     *  fast startup). */
    processors?: boolean;
    /** true = eligible to claim the per-env compaction lease, false = passive
     *  (explicit `env.compact()` still works). Default true. */
    compaction?: boolean;
    /** Process-registry participation. false = invisible non-participant;
     *  an object labels this process / forces reader-only (`register: false`). */
    processes?:
        | boolean
        | {
              name?: string;
              kind?: string;
              register?: boolean;
              listenAddr?: string | null;
              supervisorKey?: string | null;
          };
    /** Auto-compaction thresholds; `{ enabled: false }` (or OKDB_AUTO_COMPACT=0) disables. */
    autoCompact?: OKDBAutoCompactOptions;
    /** HTTP API options (e.g. defaultEnv for routes that omit :env). */
    api?: { defaultEnv?: string; [key: string]: unknown };
    /** `false` disables the admin UI entirely (`db.admin` is then null). Only `false` is
     *  read — an object form is currently ignored. */
    admin?: boolean | Record<string, unknown>;
    /** HTTP/MCP backups (`POST /api/system/backup`) may only write under `root`
     *  (default `<store>-backups`, next to the store). `db.migrate.backup(dir)` is unrestricted. */
    backup?: { root?: string };
    /** Live subscriptions (SSE) tuning. */
    subscriptions?: { beatMs?: number; [key: string]: unknown };
    /** Debug switches (e.g. `{ logRequests: true }`). */
    debug?: { logRequests?: boolean; [key: string]: unknown };
    /** Action when a license expires at runtime. */
    onLicenseExpired?: string;
}

export interface OKDBAutoCompactOptions {
    enabled?: boolean;
    checkEveryWrites?: number;
    checkEveryMs?: number;
    minFileBytes?: number;
    wastedRatioThreshold?: number;
    cooldownMs?: number;
    quietPeriodMs?: number;
    maxHotDeferMs?: number;
    [key: string]: unknown;
}

export interface OKDBAuthOptions {
    open?: boolean | string | string[];
    session?: { secure?: boolean; sameSite?: 'Lax' | 'Strict' | 'None' };
    token?: { secret?: string; ttl?: number };
    oauth?: OKDBOAuthConfig;
    providers?: Record<string, OKDBOAuthProviderConfig>;
    [key: string]: unknown;
}

export interface OKDBOAuthConfig {
    providerLabel?: string;
    issuer?: string;
    clientId?: string;
    scopes?: string[];
    [key: string]: unknown;
}

export interface OKDBOAuthProviderConfig {
    issuer: string;
    clientId: string;
    scopes?: string[];
    [key: string]: unknown;
}

export interface OKDBSyncOptions {
    address?: string;
    /** Bearer token presented to peers. */
    token?: string;
    delta_limit?: number;
    reconcile_concurrency?: number;
    auto_reconcile?: boolean;
    gcPeerStalenessLimitDays?: number;
    gcIntervalMs?: number;
    [key: string]: unknown;
}

export interface OKDBQueueOptions {
    default_ttl?: number;
    claim_batch_limit?: number;
    reconcile_batch_limit?: number;
    default_bucket_tokens?: number;
    default_max_tries?: number | null;
    default_retry_delay?: number;
    default_backoff_multiplier?: number;
    cron_next?: ((cronExpr: string, fromTimestamp: number) => number) | null;
    done_ttl?: number | null;
    failed_ttl?: number | null;
    [key: string]: unknown;
}

export interface OKDBTimeMachineOptions {
    /** Diff-flush debounce in ms (default 1000). */
    flushDelayMs?: number;
}

/** `createEnvironment(name, config)`. `sync: false` throws SYNC_OPTION_REMOVED for user envs —
 *  the changelog auto-enables with its first consumer. */
export interface OKDBEnvironmentConfig {
    durability?: 'strict' | 'balanced' | 'fast' | 'custom';
    lmdb?: Record<string, unknown>;
    compression?: boolean;
    encryptionKey?: string | Buffer;
    parentEnv?: string;
    /** Per-env role overrides (same meaning as the constructor flags). */
    engines?: boolean;
    processors?: boolean;
    compaction?: boolean;
    autoCompact?: OKDBAutoCompactOptions;
    [key: string]: unknown;
}

// ── Query and range options ───────────────────────────────────────────────────

/**
 * Pinned-snapshot mode for range reads.
 * - omitted / `false` (default for getRange/getKeys/getValues/getByPrefix): renewable read —
 *   safe to hold across `await`, consistency is per-row.
 * - `true`: frozen whole-scan view, STRICT — consume synchronously; iterating after an
 *   `await` throws `READER_HELD_ACROSS_AWAIT`.
 * - `'tolerant'`: frozen view that parks at a suspension and resumes iff no commit landed
 *   meanwhile (otherwise throws) — the error becomes load-dependent.
 */
export type OKDBSnapshotMode = boolean | 'tolerant';

/** Options for getRange/getKeys/getValues/getCount/getByPrefix. Unknown keys throw. */
export interface OKDBRangeOptions {
    start?: OKDBPrimaryKey;
    end?: OKDBPrimaryKey;
    inclusiveEnd?: boolean;
    exclusiveStart?: boolean;
    limit?: number;
    reverse?: boolean;
    offset?: number;
    versions?: boolean;
    snapshot?: OKDBSnapshotMode;
    /** A caller-managed lmdb read transaction (advanced). */
    transaction?: unknown;
}

/** FTS signal for hybrid `query()` (makes query() async). */
export interface OKDBQueryFtsSignal {
    /** FTS index name on this type. */
    name: string;
    query?: string;
    mode?: 'and' | 'or';
    prefix?: boolean;
    /** Cap on raw FTS candidates considered (default: all matches; 200 when query() has no limit). */
    limit?: number;
    /** RRF weight of the FTS signal when fused with `vector` (default 1). */
    weight?: number;
}

/** Vector signal for hybrid `query()` (makes query() async). */
export interface OKDBQueryVectorSignal {
    /** Embeddings / vector-search engine name (`<env>:` prefix optional). */
    engine: string;
    query?: string;
    limit?: number;
    /** RRF weight of the vector signal when fused with `fts` (default 1). */
    weight?: number;
}

export interface OKDBQueryNear {
    field: string;
    lat?: number;
    lon?: number;
    /** Max distance in meters. */
    radius?: number;
    /** [minLat, minLon, maxLat, maxLon] */
    bbox?: number[];
}

/**
 * query() options — a fixed vocabulary; unknown keys (including `start`/`end`) throw.
 */
export interface OKDBQueryOptions {
    index?:
        | OKDBIndexSpec
        | {
              fields: string[];
              prefix?: unknown;
              start?: OKDBIndexKey;
              end?: OKDBIndexKey;
              startKey?: OKDBPrimaryKey;
              endKey?: OKDBPrimaryKey;
          };
    /** Index prefix (a single value or an array of leading values). Requires `index`. */
    prefix?: unknown;
    /** Inclusive index-key lower/upper bound. NOT `start`/`end` — those are byIndex/getRange
     * names and are not implemented by query(); passing them throws. */
    startIndex?: OKDBIndexKey;
    endIndex?: OKDBIndexKey;
    /** Primary-key page-boundary hint (cursor-style pagination). */
    startKey?: OKDBPrimaryKey;
    endKey?: OKDBPrimaryKey;
    limit?: number;
    reverse?: boolean;
    offset?: number;
    /** Map each result row before it is returned. */
    select?: (entry: OKDBQueryEntry<any>) => any;
    /** Geo filter (alternatively `$near` / `$within` inside the filter). Rows carry `distance`. */
    near?: OKDBQueryNear;
    /** FTS signal — makes query() return a Promise. */
    fts?: OKDBQueryFtsSignal;
    /** Vector signal — makes query() return a Promise. */
    vector?: OKDBQueryVectorSignal;
    transaction?: unknown;
}

/** query() options carrying an fts or vector signal — query() then resolves asynchronously. */
export type OKDBHybridQueryOptions = OKDBQueryOptions &
    ({ fts: OKDBQueryFtsSignal } | { vector: OKDBQueryVectorSignal });

/**
 * Options for byIndex/getIndex/countByIndex. Distinct from OKDBQueryOptions: `start`/`end`
 * ARE the (direction-independent, inclusive) index-key bounds here — unlike query(), which
 * uses startIndex/endIndex instead. Index scans are always pinned + guarded: consume them
 * synchronously (see OKDBSnapshotMode).
 */
export interface OKDBIndexRangeOptions {
    /** Shorthand for start: [...prefix], end: [...prefix, HIGH_SENTINEL]. */
    prefix?: unknown;
    start?: OKDBIndexKey;
    end?: OKDBIndexKey;
    inclusiveEnd?: boolean;
    exclusiveStart?: boolean;
    reverse?: boolean;
    limit?: number;
    offset?: number;
    versions?: boolean;
    snapshot?: OKDBSnapshotMode;
    transaction?: unknown;
    /** byIndex only: include all entries violating a unique index instead of just the winner. */
    includeViolations?: boolean;
}

export interface OKDBGeoQueryOptions {
    lat?: number;
    lon?: number;
    /** Max distance in meters. */
    radius?: number;
    /** [minLat, minLon, maxLat, maxLon] bounding box (alternative to lat/lon). */
    bbox?: number[];
    /** Sift filter applied to documents. */
    filter?: OKDBFilter;
    limit?: number;
    offset?: number;
    select?: (entry: OKDBQueryEntry<any>) => any;
}

/** Options forwarded to `fts.searchDocs` by ftsQuery(). */
export interface OKDBFtsQueryOptions {
    limit?: number;
    mode?: 'and' | 'or';
    prefix?: boolean;
    [key: string]: unknown;
}

export interface OKDBWriteOptions {
    /** Optimistic concurrency: fail with VERSION_MISMATCH unless the stored version matches. */
    ifVersion?: number | null;
    /** put/create only: explicit version to store. */
    version?: number | null;
    timestamp?: number;
    /** Origin id stamped on the change (defaults to this instance). */
    origin?: string | null;
    /** Per-document TTL in ms. */
    ttl?: number | null;
}

export interface OKDBRemoveOptions {
    ifVersion?: number | null;
    timestamp?: number;
    origin?: string | null;
}

export interface OKDBTransactionOptions {
    /** Pin a consistent read view for the transaction's creation turn (true), or park/resume it
     *  across awaits while no commit lands ('tolerant'). Default false. */
    useReadTransaction?: boolean | 'tolerant';
}

// ── Result shapes ─────────────────────────────────────────────────────────────

/**
 * Lazy range result (lmdb-js RangeIterable or okdb's guarded equivalent). Iterate it or chain
 * `map`/`filter`; materialize with `Array.from(...)`.
 */
export interface OKDBRangeIterable<T> extends Iterable<T> {
    map<U>(fn: (entry: T) => U): OKDBRangeIterable<U>;
    filter(fn: (entry: T) => unknown): OKDBRangeIterable<T>;
    forEach(fn: (entry: T) => unknown): void;
}

export interface OKDBEntry<T = unknown> {
    key: OKDBPrimaryKey;
    value: T;
    version?: number;
}

export interface OKDBIndexEntry<T = unknown> extends OKDBEntry<T> {
    indexKey: OKDBIndexKey;
    indexVersion?: number;
}

/** A query() row: an entry, plus index/geo/hybrid-search fields depending on the path taken. */
export interface OKDBQueryEntry<T = unknown> extends OKDBEntry<T> {
    indexKey?: OKDBIndexKey;
    /** Geo queries: distance in meters. */
    distance?: number;
    /** Hybrid queries: combined / per-signal scores. */
    score?: number;
    ftsScore?: number;
    numTerms?: number;
    maxScore?: number;
    vectorScore?: number;
    chunkHash?: string;
    chunk?: unknown;
}

/** A change-log record (`getChanges()`; processor handlers receive the same shape). */
export interface OKDBChangeEntry {
    clock: number;
    id?: string;
    type: string;
    key?: OKDBPrimaryKey;
    /** 'put' | 'remove' | schema actions ('registerType', …). */
    action: string;
    /** HLC timestamp. */
    timestamp: number;
    origin?: string | null;
    txnId?: string;
    [key: string]: unknown;
}

export interface OKDBIndexDefinition {
    fields: string[];
    type?: 'geo';
    precision?: number;
    unique?: boolean;
}

export interface OKDBRegisterIndexOptions {
    type?: 'geo';
    /** Geohash precision (default 7). */
    precision?: number;
    unique?: boolean;
    timestamp?: number;
}

export interface OKDBTypeSchema {
    definition: Record<string, unknown>;
    enforce?: boolean;
}

/** `ensure(definition)` — idempotent type + indexes + FTS + views + schema declaration. */
export interface OKDBEnsureDefinition {
    type: string;
    indexes?: Array<string[] | OKDBIndexDefinition>;
    fts?: Array<{ name: string; fields: string[]; [key: string]: unknown }>;
    views?: Array<{ name: string; definition: Record<string, unknown> }>;
    schema?: OKDBTypeSchema | null;
}

export interface OKDBCompactResult {
    ok: boolean;
    /** Another process held the compaction lease, or the env was closing. */
    skipped?: boolean;
    reason?: string;
    /** Writers did not quiesce; auto-compaction retries later. */
    deferred?: boolean;
    sizeBefore?: number;
    sizeAfter?: number;
    saved?: number;
    savedPct?: number;
    usedLogicalRebuild?: boolean;
    [key: string]: unknown;
}

export interface OKDBRemoveEnvironmentResult {
    ok: boolean;
    name: string;
    filesRemoved: string[];
    filesLocked: string[];
    keptSubEnvs?: string[];
}

export interface OKDBTtlListOptions {
    /** Filter to a single type. */
    type?: string | null;
    /** Max entries (default 100). */
    limit?: number;
}

export interface OKDBTtlInfo {
    expiresAt: number;
    remainingMs: number;
}

export interface OKDBTtlListResult {
    items: Array<{ type: string; key: OKDBPrimaryKey; expiresAt: number; remainingMs: number; expired: boolean }>;
    total: number;
}

export interface OKDBTtlStats {
    enabled: boolean;
    totalEntries: number;
    expiredEntries: number;
    nextExpiry: number | null;
    byType: Record<string, number>;
}

export interface OKDBTtlSweepResult {
    removed: number;
    types: Record<string, number>;
}

export interface OKDBResolvedOptions {
    durability?: string;
    lmdbOptions?: unknown;
    warnings?: string[];
}

export interface OKDBRoleFlags {
    readonly processors: boolean;
    readonly engines: boolean;
    readonly compaction: boolean;
}

export interface OKDBInfoResult {
    id: string;
    pageSize: number;
    lastPageNumber: number;
    mapSize: number;
    clock: number;
    plugins: string[];
    versions: { okdb: string; lmdb: string | null; lmdbNative: string };
    version: string;
    ttl: OKDBTtlStats;
    types: Record<string, unknown>;
    config: OKDBResolvedOptions;
    [key: string]: unknown;
}
