import type {
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
    OKDBEnvironmentConfig,
    OKDBIndexDefinition,
    OKDBTypeSchema,
    OKDBCompactResult,
    OKDBTtlListOptions,
} from './options';

import type { OKDBQueue } from './features/queue';
import type { OKDBFiles } from './features/files';
import type { OKDBTimeMachine } from './features/time-machine';
import type { OKDBEngines } from './features/engines';
import type { OKDBPipelines } from './features/pipelines';
import type { OKDBFunctions } from './features/functions';
import type { OKDBViews } from './features/views';

/** Transaction object for batching writes without auto-commit. */
export interface OKDBTransaction {
    put(type: string, key: OKDBPrimaryKey, value: unknown, options?: OKDBWriteOptions): void;
    update(type: string, key: OKDBPrimaryKey, value: unknown, options?: OKDBWriteOptions): void;
    patch(type: string, key: OKDBPrimaryKey, patch: Record<string, unknown>, options?: OKDBWriteOptions): void;
    create(type: string, key: OKDBPrimaryKey, value: unknown, options?: OKDBWriteOptions): void;
    remove(type: string, key: OKDBPrimaryKey, options?: Pick<OKDBWriteOptions, 'ifVersion'>): void;
    commit(): Promise<void>;
}

/**
 * An OKDB environment — a named LMDB database within a single OKDB instance.
 * All data operations are scoped to this environment.
 * Returned by `okdb.env(name)` and `okdb.default`.
 */
export interface OKDBEnvironment {
    readonly name: string;
    readonly path: string;
    readonly config: OKDBEnvironmentConfig;
    readonly id: string;

    // ── Per-env subsystems ────────────────────────────────────────────────────
    queue: OKDBQueue;
    files: OKDBFiles;
    timeMachine?: OKDBTimeMachine;
    engines: OKDBEngines;
    pipelines: OKDBPipelines;
    functions: OKDBFunctions;
    views: OKDBViews;

    // ── Transactions ──────────────────────────────────────────────────────────
    transaction(options?: Record<string, unknown>): OKDBTransaction;
    txn<T = void>(work: (txn: OKDBTransaction) => T | Promise<T>, options?: Record<string, unknown>): Promise<T>;

    // ── CRUD ──────────────────────────────────────────────────────────────────
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

    // ── Schema ────────────────────────────────────────────────────────────────
    setSchema(type: string, schema: OKDBTypeSchema): Promise<void>;
    getSchema(type: string): OKDBTypeSchema | null;
    dropSchema(type: string): Promise<void>;

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
    getResolvedOptions(): { durability: string; lmdbOptions: unknown; warnings: string[] };
    compact(): Promise<OKDBCompactResult>;
    refreshReadTxn(): void;
}
