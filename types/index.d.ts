// ── Re-export all public types ────────────────────────────────────────────────
export type * from './options';
export type * from './errors';
export type { OKDBTransaction, OKDBEnvironment } from './environment';

// Features
export type {
    OKDBQueue,
    OKDBJob,
    OKDBJobStatus,
    OKDBJobType,
    OKDBJobBucket,
    OKDBJobBucketRecord,
    OKDBEnqueueOptions,
    OKDBClaimOptions,
    OKDBListJobsOptions,
} from './features/queue';
export type { OKDBFiles, OKDBFileRecord, OKDBUploadOptions } from './features/files';
export type { OKDBSync, OKDBSyncNode, OKDBSyncInfo } from './features/sync';
export type { OKDBAuth, OKDBToken, OKDBAuthContext, OKDBLoginResult } from './features/auth';
export type { OKDBEmbeddings, OKDBEmbeddingsPipeline, OKDBEmbeddingsSearchResult } from './features/embeddings';
export type { OKDBFts, OKDBFtsIndex, OKDBFtsQueryResult } from './features/fts';
export type { OKDBEngines, OKDBEngineDefinition } from './features/engines';
export type { OKDBFunctions, OKDBFunctionDefinition } from './features/functions';
export type { OKDBPipelines, OKDBPipelineDefinition } from './features/pipelines';
export type { OKDBViews, OKDBViewDefinition } from './features/views';
export type { OKDBMcp, OKDBMcpTool } from './features/mcp';
export type { OKDBTimeMachine, OKDBTimeMachineDiff, OKDBTimeMachineSnapshot } from './features/time-machine';
export type { OKDBAdmin } from './features/admin';
export type { OKDBApi } from './features/api';

// ── Main OKDB class ───────────────────────────────────────────────────────────
import type {
    OKDBOptions,
    OKDBEnvironmentConfig,
    OKDBPrimaryKey,
    OKDBIndexKey,
    OKDBFilter,
    OKDBRangeOptions,
    OKDBQueryOptions,
    OKDBIndexRangeOptions,
    OKDBGeoQueryOptions,
    OKDBFtsQueryOptions,
    OKDBWriteOptions,
    OKDBEntry,
    OKDBIndexEntry,
    OKDBChangeEntry,
    OKDBIndexDefinition,
    OKDBRemoveEnvironmentResult,
    OKDBTtlListOptions,
    OKDBInfoResult,
} from './options';
import type { OKDBEnvironment, OKDBTransaction } from './environment';
import type { OKDBQueue } from './features/queue';
import type { OKDBFiles } from './features/files';
import type { OKDBSync } from './features/sync';
import type { OKDBAuth } from './features/auth';
import type { OKDBEmbeddings } from './features/embeddings';
import type { OKDBFts } from './features/fts';
import type { OKDBEngines } from './features/engines';
import type { OKDBFunctions } from './features/functions';
import type { OKDBPipelines } from './features/pipelines';
import type { OKDBMcp } from './features/mcp';
import type { OKDBAdmin } from './features/admin';
import type { OKDBApi } from './features/api';
import type { EventEmitter } from 'events';

export declare class OKDB {
    static defaults: OKDBOptions;
    static HIGH_SENTINEL: Buffer;

    readonly path: string;
    readonly id: string;
    readonly options: OKDBOptions;
    readonly events: EventEmitter;

    // ── Subsystems ────────────────────────────────────────────────────────────
    readonly http: {
        /** Start the built-in HTTP server (REST API + admin UI). Single-process only —
         *  a `{ workers }` second argument throws HTTP_CLUSTER_REMOVED (okdb 2.0). */
        listen(port: number, host?: string): unknown;
        [key: string]: unknown;
    };
    readonly auth: OKDBAuth;
    readonly log: unknown;
    readonly bus: unknown;
    readonly admin: OKDBAdmin;
    readonly api: OKDBApi;
    readonly sync: OKDBSync;
    readonly embeddings: OKDBEmbeddings;
    readonly fts: OKDBFts;
    readonly engines: OKDBEngines;
    readonly pipelines: OKDBPipelines;
    readonly functions: OKDBFunctions;
    readonly mcp: OKDBMcp;
    readonly meta: unknown;
    readonly migrate: unknown;
    readonly plugins: unknown;

    // ── Queue and files are shortcuts to default env ──────────────────────────
    readonly queue: OKDBQueue;
    readonly files: OKDBFiles;

    constructor(dbPath: string, options?: OKDBOptions);

    // ── Lifecycle ─────────────────────────────────────────────────────────────
    open(): Promise<void>;
    close(): Promise<void>;
    /** Resolved role flags. `engines`/`compaction` are fixed for the instance's
     *  lifetime; `processors` reflects CURRENT participation (see processors.start/stop). */
    readonly role: { readonly processors: boolean; readonly engines: boolean; readonly compaction: boolean };
    /** Composite load signal for this node (cached 250 ms; safe to poll per claim).
     *  score ≥ 1 ≈ at the documented distress limits — the standard admission policy is
     *  `() => db.pressure().score < 1`. queuePending is workload context, not in the score. */
    pressure(): {
        writerStallMs: number;
        writerDepth: number;
        maxDurableLag: number;
        queuePending: number;
        loopLagMs: number;
        score: number;
    };
    /** Processing participation control + status.
     *  start(): begin participating — un-gate lease claiming; the first call also runs
     *  the per-store view boot that open() skips on a non-participating node.
     *  stop(): cease participating — finish in-flight quanta, release leases (peers
     *  fail over), park registrations. Both idempotent; resolve true on state change. */
    readonly processors: {
        start(): Promise<boolean>;
        stop(): Promise<boolean>;
        status(): { participate: boolean; processors: unknown[] };
        [key: string]: unknown;
    };

    // ── Environment management ────────────────────────────────────────────────
    readonly default: OKDBEnvironment;
    env(name?: string): OKDBEnvironment;
    /** Open a registered env on demand (envs always open lazily in okdb 2.0).
     *  Idempotent; throws ENV_NOT_FOUND for an unregistered name. */
    openEnv(name: string): Promise<OKDBEnvironment>;
    createEnvironment(name: string, config?: OKDBEnvironmentConfig): Promise<OKDBEnvironment>;
    removeEnvironment(name: string, options?: { keepSubEnvs?: string[] }): Promise<OKDBRemoveEnvironmentResult>;

    // ── Info ──────────────────────────────────────────────────────────────────
    readonly info: OKDBInfoResult;

    // ── Transactions ──────────────────────────────────────────────────────────
    transaction(options?: Record<string, unknown>): OKDBTransaction;
    txn<T = void>(work: (txn: OKDBTransaction) => T | Promise<T>, options?: Record<string, unknown>): Promise<T>;

    // ── CRUD (delegates to default env) ───────────────────────────────────────
    put(type: string, key: OKDBPrimaryKey, value: unknown, options?: OKDBWriteOptions): Promise<void>;
    update(type: string, key: OKDBPrimaryKey, value: unknown, options?: OKDBWriteOptions): Promise<void>;
    patch(type: string, key: OKDBPrimaryKey, patch: Record<string, unknown>, options?: OKDBWriteOptions): Promise<void>;
    create(type: string, key: OKDBPrimaryKey, value: unknown, options?: OKDBWriteOptions): Promise<void>;
    remove(type: string, key: OKDBPrimaryKey, options?: Pick<OKDBWriteOptions, 'ifVersion'>): Promise<void>;

    // ── Read ──────────────────────────────────────────────────────────────────
    get<T = unknown>(type: string, key: OKDBPrimaryKey, options?: Record<string, unknown>): T | undefined;
    getMany<T = unknown>(type: string, keys: OKDBPrimaryKey[], options?: Record<string, unknown>): (T | undefined)[];
    getEntry<T = unknown>(
        type: string,
        key: OKDBPrimaryKey,
        options?: Record<string, unknown>,
    ): OKDBEntry<T> | undefined;
    getRange<T = unknown>(type: string, options?: OKDBRangeOptions): Iterable<OKDBEntry<T>>;
    getValues<T = unknown>(type: string, options?: OKDBRangeOptions): Iterable<T>;
    getKeys(type: string, options?: OKDBRangeOptions): Iterable<OKDBPrimaryKey>;
    getCount(type: string, options?: OKDBRangeOptions): number;
    getByPrefix<T = unknown>(type: string, prefix: OKDBPrimaryKey, options?: OKDBRangeOptions): Iterable<OKDBEntry<T>>;

    // ── Index queries ─────────────────────────────────────────────────────────
    getIndex<T = unknown>(type: string, index: string[], options?: OKDBIndexRangeOptions): Iterable<OKDBIndexEntry<T>>;
    byIndex<T = unknown>(type: string, index: string[], options?: OKDBIndexRangeOptions): Iterable<OKDBIndexEntry<T>>;
    countByIndex(type: string, index: string[], options?: OKDBIndexRangeOptions): number;
    query<T = unknown>(type: string, filter: OKDBFilter, options?: OKDBQueryOptions): Iterable<OKDBIndexEntry<T>>;
    geoQuery<T = unknown>(type: string, field: string, options: OKDBGeoQueryOptions): Iterable<OKDBEntry<T>>;
    ftsQuery<T = unknown>(
        type: string,
        name: string,
        text: string,
        filter?: OKDBFilter,
        options?: OKDBFtsQueryOptions,
    ): Iterable<OKDBEntry<T>>;

    // ── Type management ───────────────────────────────────────────────────────
    registerType(type: string, timestamp?: number): Promise<void>;
    ensureType(
        type: string,
        options?: { timestamp?: number; indexes?: Array<string[] | OKDBIndexDefinition> },
    ): Promise<void>;
    hasType(type: string): boolean;
    dropType(type: string, timestamp?: number): Promise<void>;

    // ── Index management ──────────────────────────────────────────────────────
    registerIndex(
        type: string,
        index: string[],
        options?: { type?: 'geo'; precision?: number; unique?: boolean; timestamp?: number },
    ): Promise<void>;
    hasIndex(type: string, index: string[]): boolean;
    dropIndex(type: string, index: string[], timestamp?: number): Promise<void>;
    resetIndex(type: string, index: string[], clear?: boolean): Promise<void>;
    indexReady(type: string, index: string[]): Promise<boolean>;
    getIndexStatus(type: string, index: string[]): string;
    getUniqueViolations(type: string, index: string[]): unknown[];
    hasUniqueViolations(type: string, index: string[]): boolean;
    getUniqueViolation(type: string, index: string[], key: OKDBPrimaryKey): unknown;

    // ── Change tracking ───────────────────────────────────────────────────────
    getClock(type?: string, options?: Record<string, unknown>): number;
    getChanges(type?: string, from?: number, to?: number, options?: Record<string, unknown>): Iterable<OKDBChangeEntry>;

    // ── TTL ───────────────────────────────────────────────────────────────────
    setTTL(type: string, key: OKDBPrimaryKey, ttlMs: number): Promise<void>;
    getTTL(type: string, key: OKDBPrimaryKey): number | null;
    clearTTL(type: string, key: OKDBPrimaryKey): Promise<void>;
    sweepExpiredTTL(batchSize?: number): Promise<number>;
    listTTL(options?: OKDBTtlListOptions): Iterable<{ type: string; key: OKDBPrimaryKey; expiresAt: number }>;
    ttlStats(type?: string): unknown;
    setDefaultTTL(type: string, ttlMs: number): Promise<void>;
    getDefaultTTL(type: string): number | null;
    clearDefaultTTL(type: string): Promise<void>;

    // ── Utilities ─────────────────────────────────────────────────────────────
    count(iterable: Iterable<unknown>): number;
    range(iterable: Iterable<unknown>): Generator<unknown>;
    now(): number;
    equal(a: unknown, b: unknown): boolean;
    getResolvedOptions(): { durability: string; lmdbOptions: unknown; warnings: string[] };
}

export default OKDB;
