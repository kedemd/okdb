// Core option types and data shapes

export type OKDBPrimaryKey = string | number;
export type OKDBIndexKey = Array<string | number | null | Buffer>;
export type OKDBFilter = Record<string, unknown>;

// ── Constructor options ───────────────────────────────────────────────────────

export interface OKDBOptions {
    maxDbs?: number;
    pageSize?: number;
    compression?: boolean;
    encryptionKey?: string | Buffer;
    mapSize?: number;
    durability?: 'strict' | 'balanced' | 'fast' | 'custom';
    allowUnsafe?: boolean;
    lmdb?: Record<string, unknown>;
    auth?: OKDBAuthOptions;
    sync?: OKDBSyncOptions;
    queue?: OKDBQueueOptions;
    functions?: Record<string, unknown>;
    timeMachine?: OKDBTimeMachineOptions;
    runtimeDeclarations?: boolean;
    log?: { retainDays?: number };
    shutdownTimeout?: number;
    /** Lifecycle role flags — gate which background work this instance runs.
     *  Defaults preserve full-role behavior; passive instances serve reads/writes
     *  but skip engines / async processors / compaction scheduling. */
    engines?: boolean;
    /** okdb 2.0: INITIAL processing participation (claim every unclaimed `single` lease
     *  and drain derived work — FTS, views, time-machine, embeddings). Default true.
     *  false = not participating: claim nothing; reads/writes + inline processors still
     *  run. Participation is dynamic — db.processors.start()/stop() flip it at runtime
     *  (open with false + start() later = fast startup). Pass false for ephemeral
     *  short-lived processes. */
    processors?: boolean;
    /** okdb 2.0: true = eligible to claim the per-env compaction lease,
     *  false = passive (explicit env.compact() still works). */
    compaction?: boolean;
    /** Process-registry participation. false = invisible non-participant;
     *  { name } labels this process in the admin's process list. */
    processes?: boolean | { name?: string; kind?: string; register?: boolean; listenAddr?: string | null };
    /** Auto-compaction thresholds; { enabled: false } (or OKDB_AUTO_COMPACT=0) disables. */
    autoCompact?: { enabled?: boolean; [key: string]: unknown };
    /** HTTP API options (e.g. defaultEnv for routes that omit :env). */
    api?: { defaultEnv?: string; [key: string]: unknown };
    /** Admin UI feature; false disables it entirely. */
    admin?: boolean | Record<string, unknown>;
}

export interface OKDBAuthOptions {
    open?: boolean | string | string[];
    session?: { secure?: boolean; sameSite?: 'Lax' | 'Strict' | 'None' };
    token?: { secret?: string; ttl?: number };
    oauth?: OKDBOAuthConfig;
    providers?: Record<string, OKDBOAuthProviderConfig>;
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
    [key: string]: unknown;
}

export interface OKDBEnvironmentConfig {
    durability?: 'strict' | 'balanced' | 'fast' | 'custom';
    lmdb?: Record<string, unknown>;
    compression?: boolean;
    encryptionKey?: string | Buffer;
    parentEnv?: string;
    [key: string]: unknown;
}

// ── Query and range options ───────────────────────────────────────────────────

export interface OKDBRangeOptions {
    start?: OKDBPrimaryKey;
    end?: OKDBPrimaryKey;
    limit?: number;
    reverse?: boolean;
    offset?: number;
    snapshot?: boolean;
}

export interface OKDBQueryOptions {
    index?: string[] | { fields: string[]; prefix?: OKDBIndexKey; start?: OKDBIndexKey; end?: OKDBIndexKey };
    prefix?: OKDBIndexKey;
    /** Inclusive index-key lower/upper bound. NOT `start`/`end` — those are byIndex/getRange
     * names and are not implemented by query(); passing them throws. */
    startIndex?: OKDBIndexKey;
    endIndex?: OKDBIndexKey;
    /** Primary-key page-boundary hint (cursor-style pagination), as an alternative to startIndex/endIndex. */
    startKey?: OKDBPrimaryKey;
    endKey?: OKDBPrimaryKey;
    limit?: number;
    reverse?: boolean;
    offset?: number;
}

/**
 * Options for byIndex/getIndex/countByIndex. Distinct from OKDBQueryOptions: these forward
 * directly to lmdb-js's own range scan, so `start`/`end` ARE the real (direction-independent)
 * index-key bounds here — unlike query(), which uses startIndex/endIndex instead.
 */
export interface OKDBIndexRangeOptions {
    prefix?: OKDBIndexKey;
    start?: OKDBIndexKey;
    end?: OKDBIndexKey;
    reverse?: boolean;
    limit?: number;
    offset?: number;
    snapshot?: boolean;
    transaction?: unknown;
    /** byIndex only: include all entries violating a unique index instead of just the winner. */
    includeViolations?: boolean;
}

export interface OKDBGeoQueryOptions {
    lat: number;
    lon: number;
    radius?: number;
    limit?: number;
    reverse?: boolean;
}

export interface OKDBFtsQueryOptions {
    limit?: number;
    offset?: number;
    [key: string]: unknown;
}

export interface OKDBWriteOptions {
    ifVersion?: number;
    timestamp?: number;
    ttl?: number;
}

// ── Result shapes ─────────────────────────────────────────────────────────────

export interface OKDBEntry<T = unknown> {
    key: OKDBPrimaryKey;
    value: T;
    version: number;
}

export interface OKDBIndexEntry<T = unknown> extends OKDBEntry<T> {
    indexKey: OKDBIndexKey;
}

export interface OKDBChangeEntry {
    clock: number;
    origin: string;
    type: string;
    key: OKDBPrimaryKey;
    action: string;
    version?: number;
    timestamp: number;
    newValue?: unknown;
    oldValue?: unknown;
    txnId?: string;
}

export interface OKDBIndexDefinition {
    fields: string[];
    type?: 'geo';
    precision?: number;
    unique?: boolean;
}

export interface OKDBTypeSchema {
    definition: Record<string, unknown>;
    enforce?: boolean;
}

export interface OKDBCompactResult {
    ok: boolean;
    sizeBefore: number;
    sizeAfter: number;
    saved: number;
    savedPct: number;
}

export interface OKDBRemoveEnvironmentResult {
    ok: boolean;
    name: string;
    filesRemoved: string[];
    filesLocked: string[];
    keptSubEnvs?: string[];
}

export interface OKDBTtlListOptions {
    limit?: number;
    reverse?: boolean;
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
    ttl: unknown;
    types: Record<string, unknown>;
    config: unknown;
}
