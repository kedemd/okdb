import type { EventEmitter } from 'events';
import type {
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
    OKDBEnvironmentConfig,
    OKDBIndexDefinition,
    OKDBRegisterIndexOptions,
    OKDBEnsureDefinition,
    OKDBTypeSchema,
    OKDBCompactResult,
    OKDBTtlListOptions,
    OKDBTtlInfo,
    OKDBTtlListResult,
    OKDBTtlStats,
    OKDBTtlSweepResult,
    OKDBResolvedOptions,
    OKDBRoleFlags,
} from './options';
import type { OKDBFtsSearchResult } from './features/fts';
import type { OKDBQueue } from './features/queue';
import type { OKDBFiles } from './features/files';
import type { OKDBTimeMachine } from './features/time-machine';
import type { OKDBEngines } from './features/engines';
import type { OKDBPipelines } from './features/pipelines';
import type { OKDBFunctions } from './features/functions';
import type { OKDBViews } from './features/views';

// ── Transactions ──────────────────────────────────────────────────────────────

/** Write intents + committed-state reads shared by OKDBTransaction and the txn() facade.
 *  Reads see committed state only — writes queued in the same transaction are NOT visible. */
export interface OKDBTransactionOps {
    put(type: string, key: OKDBPrimaryKey, value: unknown, options?: OKDBWriteOptions): void;
    update(type: string, key: OKDBPrimaryKey, value: unknown, options?: OKDBWriteOptions): void;
    patch(type: string, key: OKDBPrimaryKey, patch: Record<string, unknown>, options?: OKDBWriteOptions): void;
    create(type: string, key: OKDBPrimaryKey, value: unknown, options?: OKDBWriteOptions): void;
    remove(type: string, key: OKDBPrimaryKey, options?: OKDBRemoveOptions): void;
    setTTL(type: string, key: OKDBPrimaryKey, ttlMs: number): void;
    clearTTL(type: string, key: OKDBPrimaryKey): void;

    get<T = unknown>(type: string, key: OKDBPrimaryKey): T | undefined;
    getEntry<T = unknown>(type: string, key: OKDBPrimaryKey): OKDBEntry<T> | undefined;
    getMany<T = unknown>(type: string, keys: OKDBPrimaryKey[]): (T | undefined)[];
    getRange<T = unknown>(type: string, options?: OKDBRangeOptions): OKDBRangeIterable<OKDBEntry<T>>;
    getValues<T = unknown>(type: string, options?: OKDBRangeOptions): OKDBRangeIterable<T>;
    getKeys(type: string, options?: OKDBRangeOptions): OKDBRangeIterable<OKDBPrimaryKey>;
    byIndex<T = unknown>(
        type: string,
        index: OKDBIndexSpec,
        options?: OKDBIndexRangeOptions,
    ): OKDBRangeIterable<OKDBIndexEntry<T>>;
    query<T = unknown>(type: string, filter?: OKDBFilter, options?: OKDBQueryOptions): Iterable<OKDBQueryEntry<T>>;
    getClock(type?: string | null): number;
    getCount(type: string): number;
}

/**
 * Explicit transaction from `transaction()`: queue writes, then `commit()` applies them
 * atomically through the env's single writer. With `useReadTransaction`, reads see a consistent
 * view for the creation turn only (READER_HELD_ACROSS_AWAIT after an await, unless 'tolerant').
 */
export interface OKDBTransaction extends OKDBTransactionOps {
    readonly id: string;
    commit(): Promise<void>;
    rollback(): void;
}

/** The frozen facade passed to `txn(work)`; the transaction commits when `work` resolves
 *  (don't call `commit()` yourself inside `work`). */
export interface OKDBTransactionFacade extends OKDBTransactionOps {
    readonly id: string;
    commit(): Promise<void>;
    rollback(): void;
}

/** Declarative op for `txn([...ops])`: `{ action, type, key, value?, patch?, ttl?, options? }`
 *  or a tuple `['put', type, key, value, options?]`. */
export type OKDBTransactionOp =
    | {
          action: 'put' | 'update' | 'create';
          type: string;
          key: OKDBPrimaryKey;
          value: unknown;
          ttl?: number | null;
          options?: OKDBWriteOptions;
      }
    | {
          action: 'patch';
          type: string;
          key: OKDBPrimaryKey;
          patch: Record<string, unknown>;
          ttl?: number | null;
          options?: OKDBWriteOptions;
      }
    | { action: 'remove'; type: string; key: OKDBPrimaryKey; options?: OKDBRemoveOptions }
    | { action: 'setTTL'; type: string; key: OKDBPrimaryKey; ttl: number }
    | { action: 'clearTTL'; type: string; key: OKDBPrimaryKey }
    | [string, ...unknown[]];

/** `txn()` resolves with the committed transaction's id and action count. */
export interface OKDBTxnResult {
    id: string;
    actions: number;
}

// ── Processors ────────────────────────────────────────────────────────────────

/** Processor handler: `fn(ctx, changes, info)` with `ctx = { env, payload }`. */
export type OKDBProcessorHandler = (
    ctx: { env: OKDBEnvironment; payload: unknown; [key: string]: unknown },
    changes: OKDBChangeEntry[],
    info: unknown,
) => unknown;

/** `env.processor.register(type, options)`. Exactly one of `module` / `handler` is required;
 *  bare closures throw. */
export interface OKDBProcessorRegisterOptions {
    /** File handler: `{ path, export }`, called as `fn(ctx, changes, info)`. */
    module?: { path: string; export?: string };
    /** Name of a handler registered with `OKDBProcessor.registerHandler(name, fn)`. */
    handler?: string;
    payload?: unknown;
    /** `'async'` (default; background drain) | `'sync'` (every writer, inside the commit).
     *  Deprecated aliases `'single'` / `'worker'` / `'fanout'` / `'inline'` warn. */
    mode?: 'async' | 'sync' | 'single' | 'worker' | 'fanout' | 'inline';
    /** mode:'async' only: `'single'` (1-of-N, leased, durable cursor) | `'fanout'` (N-of-N). */
    distribution?: 'single' | 'fanout';
    bootstrap?: 'snapshot' | 'log';
    originMode?: 'self' | 'remote' | 'all';
    batchSize?: number;
    hydrateValues?: boolean;
    /** Durable resume position key. */
    cursorKey?: string | null;
    lockMode?: 'exclusive' | null;
    failOnHandlerError?: boolean;
    name?: string | null;
    meta?: Record<string, unknown>;
    leaseTtlMs?: number;
    /** Trailing-edge debounce in ms (0 = flush immediately). */
    flushDebounce?: number;
    /** Periodic poll interval in ms after bootstrap (null = disabled). */
    flushInterval?: number | null;
    /** Tail the whole-env change log instead of one type. */
    envWide?: boolean;
    drainDeadlineMs?: number;
    flushQuantum?: number | null;
    /** `{ durable: true }` marks a sync handler reconstructible on every instance. */
    definition?: { durable?: boolean; [key: string]: unknown } | null;
}

/** A processor's status row. */
export interface OKDBProcessorStatus {
    id: string;
    type: string | null;
    /** Public mode token: 'single' (1-of-N), 'fanout' (N-of-N) or 'inline'. */
    mode: string;
    state: string;
    paused: boolean;
    unclaimed: boolean;
    claimGated: boolean;
    heldBy: { pid: number | null; hostname: string | null } | null;
    lastClock: number;
    headClock: number;
    logHead: number;
    envClock: number | null;
    /** Pending changes, computed from the durable cursor. */
    lag: number;
    bootstrap: string;
    progress: unknown;
    error: unknown;
    meta: Record<string, unknown>;
    cursorKey: string | null;
    [key: string]: unknown;
}

/** Returned by `processor.register()`: call it (await) to unregister; carries controls. */
export interface OKDBProcessorHandle {
    (): Promise<void>;
    readonly id: string;
    readonly cursorKey: string | null;
    /** The durable (persisted, cross-process) cursor. */
    durableClock(): number;
    status(): OKDBProcessorStatus | null;
    getStatus(): OKDBProcessorStatus | null;
    pause(): boolean;
    resume(): boolean;
    retry(): boolean;
    kick(): boolean;
    awaitIdle(): Promise<void>;
}

/** Per-env change-subscription primitive (`env.processor`). */
export interface OKDBEnvProcessor {
    register(type: string | null, options: OKDBProcessorRegisterOptions): OKDBProcessorHandle;
    list(): OKDBProcessorStatus[];
    get(id: string): OKDBProcessorStatus | null;
    pause(id: string): boolean;
    resume(id: string): boolean;
    retry(id: string): boolean;
    kick(id: string): boolean;
    awaitIdle(id: string): Promise<void>;
    getCursor(cursorKey: string): number;
    setCursor(cursorKey: string, clock: number): void;
    resetCursor(cursorKey: string): void;
    /** Flip a processor's mode at runtime (durable, cross-process). `logicalKey` = `env::cursorKey`. */
    setMode(logicalKey: string, mode: string, distribution?: 'single' | 'fanout'): Promise<unknown>;
    restart(logicalKey: string, options?: { reset?: boolean }): boolean;
    [key: string]: unknown;
}

// ── Environment ───────────────────────────────────────────────────────────────

export interface OKDBStorageStats {
    fileBytes: number | null;
    usedBytes: number | null;
    liveBytes: number | null;
    reclaimableBytes: number | null;
    reclaimablePct: number | null;
    warn: boolean;
    lastTxnId: number | null;
    readers: {
        count: number;
        maxTxnsBehind: number;
        list: Array<{ pid: number; txnId: number | null; txnsBehind: number }>;
    };
    lastCompact: unknown;
    autoCompact: { enabled: boolean; eligible: boolean };
}

export interface OKDBWriterStatus {
    depth: number;
    /** Age of the oldest pending commit — THE stall signal. */
    oldestPendingMs: number;
    committed?: number;
    commitsPerSec: number;
    commitP99Ms: number;
    draining: boolean;
    drainTs: number;
    activeWriters: number;
    ownWriters: number;
    [key: string]: unknown;
}

/**
 * An OKDB environment — a named LMDB database within a single OKDB instance.
 * All data operations are scoped to this environment.
 * Returned by `db.env(name)`, `db.openEnv(name)`, `db.createEnvironment(name)` and `db.default`.
 */
export interface OKDBEnvironment {
    readonly name: string;
    readonly path: string;
    readonly config: OKDBEnvironmentConfig;
    /** Instance identity (shared with the owning OKDB). */
    readonly id: string;
    /** Shared with the owning OKDB (`db.events`). */
    readonly events: EventEmitter;
    /** Role flags for this env (processors mirrors the owner's current participation). */
    readonly role: OKDBRoleFlags;

    // ── Per-env subsystems ────────────────────────────────────────────────────
    readonly queue: OKDBQueue;
    readonly files: OKDBFiles;
    /** Present only when the `timeMachine` constructor option is set (and licensed). */
    readonly timeMachine?: OKDBTimeMachine;
    readonly engines: OKDBEngines;
    readonly pipelines: OKDBPipelines;
    readonly functions: OKDBFunctions;
    readonly views: OKDBViews;
    readonly processor: OKDBEnvProcessor;

    // ── Transactions ──────────────────────────────────────────────────────────
    transaction(options?: OKDBTransactionOptions): OKDBTransaction;
    /** Run `work` (or apply declarative `ops`) and commit atomically. */
    txn(
        work: ((txn: OKDBTransactionFacade) => unknown) | OKDBTransactionOp[],
        options?: OKDBTransactionOptions,
    ): Promise<OKDBTxnResult>;

    // ── CRUD ──────────────────────────────────────────────────────────────────
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

    // ── Index queries (pinned + guarded: consume synchronously) ───────────────
    /** Raw index scan — yields the primary keys stored in the index. */
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
    geoQuery<T = unknown>(
        type: string,
        field: string,
        options: OKDBGeoQueryOptions,
    ): Iterable<OKDBQueryEntry<T> & { distance?: number }>;
    /** FTS search with an optional post-filter; returns hydrated, scored docs. */
    ftsQuery(
        type: string,
        name: string,
        text: string,
        filter?: OKDBFilter,
        options?: OKDBFtsQueryOptions,
    ): OKDBFtsSearchResult[];

    // ── Type management ───────────────────────────────────────────────────────
    registerType(type: string, timestamp?: number): Promise<void>;
    /** Get-or-create a type (race-safe across processes) plus its indexes. */
    ensureType(
        type: string,
        options?: { timestamp?: number; indexes?: Array<string[] | OKDBIndexDefinition> },
    ): Promise<void>;
    /** Idempotent declaration of a type with its indexes, FTS indexes, views and schema. */
    ensure(definition: OKDBEnsureDefinition): Promise<void>;
    hasType(type: string): boolean;
    dropType(type: string, timestamp?: number): Promise<void>;

    // ── Resolved fields (content served by the app, never stored) ────────────
    /**
     * Serve `field` of `type` from `resolver` instead of storage: FTS, the embeddings indexer and
     * search-result chunk text read it through the resolver when a row has no stored `field`.
     * Return `null`/`undefined` for "no content"; throw for a read error (fails that item only).
     * The declaration is durable; register the resolver in every process that runs those indexes,
     * or they fail with FIELD_RESOLVER_MISSING. Resolves to an unregister function.
     */
    resolveField(
        type: string,
        field: string,
        resolver: ((row: any, key: string) => unknown | Promise<unknown>) | null,
        options?: {
            /** Resolve many rows per call: values in input order; an Error value fails that item only. */
            batch?: (items: Array<{ row: any; key: string }>) => Promise<unknown[]>;
            /** Rows per batch call (default 256). */
            batchSize?: number;
        },
    ): Promise<() => void>;
    /** Remove the declaration and this process's resolver. */
    unresolveField(type: string, field: string): Promise<void>;
    /** Fields of `type` declared as resolved. */
    resolvedFields(type: string): string[];
    /** `field` of one row: the stored value, else the resolver's. */
    readField(type: string, key: string, value: any, field: string): Promise<unknown>;

    // ── Schema ────────────────────────────────────────────────────────────────
    setSchema(type: string, schema: OKDBTypeSchema): Promise<void>;
    getSchema(type: string): OKDBTypeSchema | null;
    dropSchema(type: string): Promise<void>;
    /** Schema-violation record for one document (non-enforced schemas), or null. */
    getViolation(type: string, key: OKDBPrimaryKey): unknown;
    listViolations(type?: string | null): unknown[];
    /** Foreign-key violation record, or null. */
    getRefViolation(sourceType: string, sourceKey: OKDBPrimaryKey, fieldPath: string): unknown;
    listRefViolations(sourceType?: string | null): unknown[];

    // ── Index management ──────────────────────────────────────────────────────
    registerIndex(type: string, index: OKDBIndexSpec, options?: OKDBRegisterIndexOptions | number): Promise<void>;
    hasIndex(type: string, index: OKDBIndexSpec): boolean;
    dropIndex(type: string, index: OKDBIndexSpec, timestamp?: number): Promise<void>;
    resetIndex(type: string, index: OKDBIndexSpec, clear?: boolean): Promise<void>;
    /** Resolves true once the index build is complete. */
    indexReady(type: string, index: OKDBIndexSpec): Promise<boolean>;
    getIndexStatus(type: string, index: OKDBIndexSpec): string;
    getUniqueViolations(type?: string | null, index?: OKDBIndexSpec): unknown[];
    hasUniqueViolations(type?: string | null, index?: OKDBIndexSpec): boolean;
    getUniqueViolation(type: string, index: OKDBIndexSpec, indexKey: OKDBIndexKey): unknown;

    // ── Change tracking ───────────────────────────────────────────────────────
    getClock(type?: string | null, options?: Record<string, unknown>): number;
    /** Change log between two clocks (reverse when from > to). Pinned + guarded. */
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

    // ── Maintenance / observability ───────────────────────────────────────────
    /** Compact data.mdb (skips when another process holds the compaction lease). `force` drains
     *  harder; `repair` forces a logical rebuild. Concurrent calls reject with REBUILD_IN_PROGRESS. */
    compact(options?: { force?: boolean; repair?: boolean }): Promise<OKDBCompactResult>;
    /** Force a logical rebuild (operator-triggered repair). */
    repair(options?: { force?: boolean }): Promise<OKDBCompactResult>;
    storageStats(): OKDBStorageStats;
    writerStatus(): OKDBWriterStatus;
    /** OKDB_DIAG snapshot (`{ enabled: false, … }` unless OKDB_DIAG=1). */
    diag(): Record<string, unknown>;
    getResolvedOptions(): OKDBResolvedOptions;
    refreshReadTxn(): void;

    // ── Utilities ─────────────────────────────────────────────────────────────
    count(iterable: Iterable<unknown>): number;
    /** Yield every item of a range iterable (e.g. a `getRange()` result) or any iterable. */
    range<T>(iterable: Iterable<T>): Generator<T, void, undefined>;
    /** Current HLC time in ms. */
    now(): number;
}
