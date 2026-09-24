import type { EventEmitter } from 'events';
import type { Server, IncomingMessage, ServerResponse } from 'http';
import type {
    OKDBOptions,
    OKDBEnvironmentConfig,
    OKDBPrimaryKey,
    OKDBIndexKey,
    OKDBIndexSpec,
    OKDBFilter,
    OKDBRangeOptions,
    OKDBQueryOptions,
    OKDBHybridQueryOptions,
    OKDBIndexRangeOptions,
    OKDBGeoQueryOptions,
    OKDBFtsQueryOptions,
    OKDBWriteOptions,
    OKDBRemoveOptions,
    OKDBTransactionOptions,
    OKDBEntry,
    OKDBIndexEntry,
    OKDBQueryEntry,
    OKDBChangeEntry,
    OKDBRangeIterable,
    OKDBIndexDefinition,
    OKDBRegisterIndexOptions,
    OKDBEnsureDefinition,
    OKDBTypeSchema,
    OKDBRemoveEnvironmentResult,
    OKDBTtlListOptions,
    OKDBTtlInfo,
    OKDBTtlListResult,
    OKDBTtlStats,
    OKDBTtlSweepResult,
    OKDBResolvedOptions,
    OKDBRoleFlags,
    OKDBInfoResult,
} from './options';
import type {
    OKDBEnvironment,
    OKDBEnvProcessor,
    OKDBProcessorStatus,
    OKDBTransaction,
    OKDBTransactionFacade,
    OKDBTransactionOp,
    OKDBTxnResult,
} from './environment';
import type { OKDBQueue } from './features/queue';
import type { OKDBFiles } from './features/files';
import type { OKDBSync } from './features/sync';
import type { OKDBAuth } from './features/auth';
import type { OKDBEmbeddings } from './features/embeddings';
import type { OKDBFts, OKDBFtsSearchResult } from './features/fts';
import type { OKDBEngines } from './features/engines';
import type { OKDBFunctions } from './features/functions';
import type { OKDBPipelines } from './features/pipelines';
import type { OKDBMcp } from './features/mcp';
import type { OKDBAdmin } from './features/admin';
import type { OKDBApi } from './features/api';
import type { OKDBLicenses } from './features/licenses';

// ── HTTP ──────────────────────────────────────────────────────────────────────

/** Request object seen by middleware, guards and route handlers. */
export interface OKDBHttpRequest {
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
    query: Record<string, unknown>;
    params?: Record<string, string | undefined>;
    cookies?: Record<string, string>;
    context: Record<string, unknown>;
    [key: string]: unknown;
}

/** A normalized response (`handle()` resolves to one). JSON bodies use the
 *  `{ data, error, meta }` envelope. */
export interface OKDBHttpResponse {
    status: number;
    headers: Record<string, string>;
    body: unknown;
}

/** Route handler input: `{ params, query, headers, body, context, … }`. Return
 *  `{ result }`, `{ status, body, headers }`, a stream/buffer/string, or nothing. */
export type OKDBHttpRouteHandler = (req: OKDBHttpRequest & Record<string, any>) => unknown;

export interface OKDBHttp {
    /**
     * Start the built-in HTTP server (REST API + admin UI). Single-process only — a
     * `{ workers }` option throws HTTP_CLUSTER_REMOVED (use `bin/okdb` or Node `cluster`).
     * `host` binds one address (default: all interfaces); an array binds each address with its
     * own server sharing one request handler. Returns the Node `http.Server` — for an array, the
     * one bound to the first address (all of them are on `servers`; an 'error' from any is
     * re-emitted on the returned one; `close()` closes them all). A string / array second
     * argument is shorthand for `{ host }`.
     */
    listen(port: number, opts?: string | string[] | { host?: string | string[] }): Server;
    /** Stop every server started by listen(). */
    close(options?: Record<string, unknown>): Promise<void>;
    /** The server returned by the last listen(), or null. */
    readonly server: Server | null;
    /** Every server the last listen() started (one per bound host). */
    readonly servers: Server[];
    /** Max JSON request body in bytes (default 5 MB). */
    maxBodyBytes: number;
    /** Add a middleware: `(req, res, next) => …`; call `await next()` to continue. */
    use(fn: (req: OKDBHttpRequest, res: unknown, next: () => Promise<unknown>) => unknown): void;
    /** Add a guard: runs before middleware for matching requests; return false to deny. */
    guard(match: (req: OKDBHttpRequest) => boolean, handler: (req: OKDBHttpRequest, res: unknown) => unknown): void;
    /** Register a route. Path params use `:name`; a trailing `/*` matches a subtree. */
    add(method: string, path: string, handler: OKDBHttpRouteHandler, meta?: Record<string, unknown>): void;
    /** Register a raw-body route (`context.rawStream` carries the unparsed request body). */
    addRaw(method: string, path: string, handler: OKDBHttpRouteHandler, meta?: Record<string, unknown>): void;
    /** Register a Server-Sent Events endpoint. `setup` returns an optional cleanup function. */
    addSSE(
        path: string,
        setup: (conn: {
            send(event: string, data: unknown): void;
            close(): void;
            query: Record<string, unknown>;
            headers: Record<string, unknown>;
            context: { req?: IncomingMessage; res?: ServerResponse; [key: string]: unknown };
            setHeader(name: string, value: string): void;
        }) => unknown,
        meta?: Record<string, unknown>,
    ): void;
    /** Dispatch a request through guards, middleware and routes without a server (bring your own
     *  framework). */
    handle(
        method: string,
        path: string,
        request?: {
            body?: unknown;
            query?: Record<string, unknown>;
            headers?: Record<string, unknown>;
            [key: string]: unknown;
        },
        context?: { req?: IncomingMessage; res?: ServerResponse; [key: string]: unknown },
    ): Promise<OKDBHttpResponse>;
    listRoutes(): Array<{ method: string; path: string; meta: Record<string, unknown>; [key: string]: unknown }>;
}

// ── Processors facade ─────────────────────────────────────────────────────────

/**
 * `db.processors` — processing participation control + status.
 * Removed: `process()`, `processRest()`, `processEverything()` (throw — use `processors: true`).
 */
export interface OKDBProcessors {
    /** Begin participating — un-gate lease claiming; the first call also runs the per-store
     *  view boot that open() skips on a non-participating node. Resolves true on state change. */
    start(): Promise<boolean>;
    /** Cease participating — finish in-flight quanta, release leases (peers fail over), park
     *  registrations. Resolves true on state change. */
    stop(): Promise<boolean>;
    /** Leased (`single`) processors across user envs. */
    status(): { participate: boolean; processors: Array<OKDBProcessorStatus & { env: string }> };
}

export interface OKDBPressure {
    /** Max oldest-pending commit age across open envs (THE stall signal). */
    writerStallMs: number;
    writerDepth: number;
    /** Max durable processor lag (clock units) across user envs. */
    maxDurableLag: number;
    /** Pending + retry jobs across user envs (workload context; not in `score`). */
    queuePending: number;
    loopLagMs: number;
    /** Max of the normalized distress signals: ≥ 1 ≈ at the documented limits. */
    score: number;
}

// ── Main class ────────────────────────────────────────────────────────────────

/**
 * The top-level okdb instance. Document operations on `db` delegate to the `default`
 * environment; use `db.env(name)` for others.
 *
 * Removed: `db.workers` (throws WORKERS_REMOVED — run more processes with `processors: true`).
 */
export declare class OKDB {
    static defaults: OKDBOptions;
    /** Sentinel Buffer for open-ended index range ends: `end: [prefix, OKDB.HIGH_SENTINEL]`. */
    static HIGH_SENTINEL: Buffer;
    /**
     * Register a named custom bucket projection, process-wide. Views reference it by name
     * (`bucket: { field, granularity, project: '<name>' }`) — a function can't be persisted.
     * Call before open() in every process that opens the store; a stored view whose projection
     * is unregistered at open() is held back (getMeta → state 'error') until registered + rebuilt.
     */
    static registerBucketProjection(name: string, fn: (value: unknown) => string | null | undefined): void;
    /**
     * Register a named custom view reducer, process-wide (all envs). Like
     * `env.views.registerReducer`, but callable before open() so a stored view using it is
     * live from boot. Name must start with '$' and not be a built-in or `$ref`.
     */
    static registerViewReducer(name: string, reducer: import('./features/views').OKDBCustomReducer): void;

    constructor(dbPath: string, options?: OKDBOptions);

    readonly path: string;
    /** Instance identity (set at open()). */
    readonly id: string;
    readonly options: OKDBOptions;
    readonly events: EventEmitter;
    /** The okdb package version (no env needs to be open). */
    readonly version: string;
    /** Lifecycle state. */
    readonly state: string;

    // ── Subsystems ────────────────────────────────────────────────────────────
    readonly http: OKDBHttp;
    readonly auth: OKDBAuth;
    readonly log: unknown;
    /** UDP bus (null when the shmbuf native binding is missing). */
    readonly bus: unknown;
    /** null when constructed with `admin: false`. */
    readonly admin: OKDBAdmin | null;
    readonly api: OKDBApi;
    readonly sync: OKDBSync;
    readonly embeddings: OKDBEmbeddings;
    readonly fts: OKDBFts;
    /** Engine orchestrator (per-env engines live on `env.engines`). */
    readonly engines: OKDBEngines;
    /** Read-only pipeline coordinator (create/update on `env.pipelines`). */
    readonly pipelines: OKDBPipelines;
    /** Install / list / inspect licenses from code (after open()). */
    readonly licenses: OKDBLicenses;
    /** Functions registered in `~system` (per-env functions live on `env.functions`). */
    readonly functions: OKDBFunctions;
    readonly mcp: OKDBMcp;
    readonly processors: OKDBProcessors;
    /** Process registry (the `/api/processes` census). */
    readonly processes: unknown;
    readonly meta: unknown;
    readonly migrate: unknown;
    readonly plugins: unknown;
    /** Named cross-process mutexes in `~system`. */
    readonly locks: unknown;
    /** The default env's processor. */
    readonly processor: OKDBEnvProcessor;

    // ── Queue and files are shortcuts to the default env ──────────────────────
    readonly queue: OKDBQueue;
    readonly files: OKDBFiles;

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    open(): Promise<void>;
    close(): Promise<void>;
    /** Resolved role flags. `engines`/`compaction` are fixed for the instance's lifetime;
     *  `processors` reflects CURRENT participation (see processors.start/stop). */
    readonly role: OKDBRoleFlags;
    /** Composite load signal for this node (cached 250 ms; safe to poll per claim). The
     *  standard admission policy is `() => db.pressure().score < 1`. */
    pressure(): OKDBPressure;
    /** OKDB_DIAG snapshot (`{ enabled: false, … }` unless OKDB_DIAG=1). */
    diag(): Record<string, unknown>;
    /** @deprecated Pools were removed; use per-processor pause/resume instead. */
    setProcessingConfig(config: Record<string, unknown>): Promise<void>;

    // ── Environment management ────────────────────────────────────────────────
    readonly default: OKDBEnvironment;
    /** An already-open env (throws ENV_NOT_FOUND otherwise — use openEnv() for lazy open). */
    env(name?: string): OKDBEnvironment;
    /** Open a registered env on demand (envs always open lazily). Idempotent; throws
     *  ENV_NOT_FOUND for an unregistered name. */
    openEnv(name: string): Promise<OKDBEnvironment>;
    /** Create (register + open) an env; idempotent. */
    createEnvironment(name: string, config?: OKDBEnvironmentConfig): Promise<OKDBEnvironment>;
    removeEnvironment(name: string, options?: { keepSubEnvs?: string[] }): Promise<OKDBRemoveEnvironmentResult>;
    /** Envs that failed to open at boot: `{ [name]: { path, error, at } }`. */
    readonly quarantinedEnvs: Record<string, { path: string; error: unknown; at: number }>;

    // ── Info ──────────────────────────────────────────────────────────────────
    readonly info: OKDBInfoResult;
    getResolvedOptions(): OKDBResolvedOptions;

    // ── Transactions ──────────────────────────────────────────────────────────
    transaction(options?: OKDBTransactionOptions): OKDBTransaction;
    txn(
        work: ((txn: OKDBTransactionFacade) => unknown) | OKDBTransactionOp[],
        options?: OKDBTransactionOptions,
    ): Promise<OKDBTxnResult>;

    // ── CRUD (default env) ────────────────────────────────────────────────────
    put(type: string, key: OKDBPrimaryKey, value: unknown, options?: OKDBWriteOptions): Promise<void>;
    update(type: string, key: OKDBPrimaryKey, value: unknown, options?: OKDBWriteOptions): Promise<void>;
    patch(type: string, key: OKDBPrimaryKey, patch: Record<string, unknown>, options?: OKDBWriteOptions): Promise<void>;
    create(type: string, key: OKDBPrimaryKey, value: unknown, options?: OKDBWriteOptions): Promise<void>;
    remove(type: string, key: OKDBPrimaryKey, options?: OKDBRemoveOptions): Promise<void>;

    // ── Read (synchronous) ────────────────────────────────────────────────────
    get<T = unknown>(type: string, key: OKDBPrimaryKey, options?: Record<string, unknown>): T | undefined;
    getMany<T = unknown>(type: string, keys: OKDBPrimaryKey[], options?: Record<string, unknown>): (T | undefined)[];
    getEntry<T = unknown>(
        type: string,
        key: OKDBPrimaryKey,
        options?: Record<string, unknown>,
    ): OKDBEntry<T> | undefined;
    getRange<T = unknown>(type: string, options?: OKDBRangeOptions): OKDBRangeIterable<OKDBEntry<T>>;
    getValues<T = unknown>(type: string, options?: OKDBRangeOptions): OKDBRangeIterable<T>;
    getKeys(type: string, options?: OKDBRangeOptions): OKDBRangeIterable<OKDBPrimaryKey>;
    getCount(type: string, options?: OKDBRangeOptions): number;
    getByPrefix<T = unknown>(type: string, prefix: string, options?: OKDBRangeOptions): OKDBRangeIterable<OKDBEntry<T>>;

    // ── Index queries ─────────────────────────────────────────────────────────
    getIndex(type: string, index: string[], options?: OKDBIndexRangeOptions): OKDBRangeIterable<OKDBPrimaryKey>;
    byIndex<T = unknown>(
        type: string,
        index: OKDBIndexSpec,
        options?: OKDBIndexRangeOptions,
    ): OKDBRangeIterable<OKDBIndexEntry<T>>;
    countByIndex(type: string, index: OKDBIndexSpec, options?: OKDBIndexRangeOptions): number;
    /** With an `fts` or `vector` signal, query() is async and resolves to an array. */
    query<T = unknown>(type: string, filter: OKDBFilter, options: OKDBHybridQueryOptions): Promise<OKDBQueryEntry<T>[]>;
    query<T = unknown>(type: string, filter?: OKDBFilter, options?: OKDBQueryOptions): Iterable<OKDBQueryEntry<T>>;
    geoQuery<T = unknown>(type: string, field: string, options: OKDBGeoQueryOptions): Iterable<OKDBQueryEntry<T>>;
    ftsQuery(
        type: string,
        name: string,
        text: string,
        filter?: OKDBFilter,
        options?: OKDBFtsQueryOptions,
    ): OKDBFtsSearchResult[];

    // ── Type management ───────────────────────────────────────────────────────
    registerType(type: string, timestamp?: number): Promise<void>;
    ensureType(
        type: string,
        options?: { timestamp?: number; indexes?: Array<string[] | OKDBIndexDefinition> },
    ): Promise<void>;
    ensure(definition: OKDBEnsureDefinition): Promise<void>;
    getSchema(type: string): OKDBTypeSchema | null;
    hasType(type: string): boolean;
    dropType(type: string, timestamp?: number): Promise<void>;

    // ── Index management ──────────────────────────────────────────────────────
    registerIndex(type: string, index: OKDBIndexSpec, options?: OKDBRegisterIndexOptions | number): Promise<void>;
    hasIndex(type: string, index: OKDBIndexSpec): boolean;
    dropIndex(type: string, index: OKDBIndexSpec, timestamp?: number): Promise<void>;
    resetIndex(type: string, index: OKDBIndexSpec, clear?: boolean): Promise<void>;
    indexReady(type: string, index: OKDBIndexSpec): Promise<boolean>;
    getIndexStatus(type: string, index: OKDBIndexSpec): string;
    getUniqueViolations(type?: string | null, index?: OKDBIndexSpec): unknown[];
    hasUniqueViolations(type?: string | null, index?: OKDBIndexSpec): boolean;
    getUniqueViolation(type: string, index: OKDBIndexSpec, indexKey: OKDBIndexKey): unknown;

    // ── Change tracking ───────────────────────────────────────────────────────
    getClock(type?: string | null, options?: Record<string, unknown>): number;
    getChanges(
        type?: string | null,
        from?: number,
        to?: number,
        options?: { snapshot?: boolean | 'tolerant'; limit?: number; transaction?: unknown },
    ): Iterable<OKDBChangeEntry>;

    // ── TTL ───────────────────────────────────────────────────────────────────
    setTTL(type: string, key: OKDBPrimaryKey, ttlMs: number): Promise<void>;
    getTTL(type: string, key: OKDBPrimaryKey): OKDBTtlInfo | null;
    clearTTL(type: string, key: OKDBPrimaryKey): Promise<void>;
    sweepExpiredTTL(batchSize?: number): Promise<OKDBTtlSweepResult>;
    listTTL(options?: OKDBTtlListOptions): OKDBTtlListResult;
    ttlStats(type?: string | null): OKDBTtlStats;
    setDefaultTTL(type: string, ttlMs: number): Promise<void>;
    getDefaultTTL(type: string): number | null;
    clearDefaultTTL(type: string): Promise<void>;

    // ── Utilities ─────────────────────────────────────────────────────────────
    count(iterable: Iterable<unknown>): number;
    /** Yield every item of a range iterable (e.g. a `getRange()` result) or any iterable. */
    range<T>(iterable: Iterable<T>): Generator<T, void, undefined>;
    /** Current HLC time in ms. */
    now(): number;
    /** Deep equality as used by okdb. */
    equal(a: unknown, b: unknown): boolean;
}
