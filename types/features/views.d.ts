/** Sift-style (MongoDB-compatible) filter object */
export type OKDBFilter = Record<string, unknown>;

/** Map operator specs */
export type OKDBMapRefSpec = { $ref: [type: string, fkField: string, targetField: string] };
export type OKDBMapConcatSpec = { $concat: string[] };
export type OKDBMapCoalesceSpec = { $coalesce: string[] };
export type OKDBMapFieldSpec = string | OKDBMapRefSpec | OKDBMapConcatSpec | OKDBMapCoalesceSpec;

/** Declarative per-doc transform merged onto source docs before reducers run */
export type OKDBViewMap = Record<string, OKDBMapFieldSpec>;

/** Built-in reducer specs */
export type OKDBCountSpec = { $count: true; items?: boolean };
export type OKDBSumSpec = { $sum: string; items?: boolean };
export type OKDBAvgSpec = { $avg: string; items?: boolean };
export type OKDBMinSpec = { $min: string; items?: boolean };
export type OKDBMaxSpec = { $max: string; items?: boolean };
export type OKDBCountBySpec = { $countBy: string; items?: boolean };
export type OKDBCustomSpec = { [reducer: string]: unknown; items?: boolean };

/** $ref sub-view aggregation */
export interface OKDBRefSpec {
    type: string;
    key: string;
    filter?: OKDBFilter;
    reduce: Record<string, OKDBReducerSpec>;
}

export type OKDBReducerSpec =
    | OKDBCountSpec
    | OKDBSumSpec
    | OKDBAvgSpec
    | OKDBMinSpec
    | OKDBMaxSpec
    | OKDBCountBySpec
    | { $ref: OKDBRefSpec }
    | OKDBCustomSpec;

/** Allowed granularity values for preset:'time' bucket configs */
export type OKDBBucketTimeGranularity = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * Bucket configuration for bucketed views.
 * Use preset:'time' for time-series bucketing (JSON-serializable, works in synced envs).
 * Use project for custom string-key bucketing (JS only, not usable in synced envs).
 */
export type OKDBBucketConfig =
    | {
          /** Dot path to the timestamp field on each source document (Unix ms or ISO string). */
          field: string;
          /** Time-based bucketing. Currently the only supported preset. */
          preset: 'time';
          /** Bucket size. One of: minute, hour, day, week, month, quarter, year. */
          granularity: OKDBBucketTimeGranularity;
      }
    | {
          /** Dot path to the grouping field on each source document. */
          field: string;
          /** Custom projection: maps a field value to a string bucket key. Not usable in synced environments. */
          project: (value: unknown) => string;
          /** Arbitrary label used in bucket keys and range queries. */
          granularity: string;
      };

/** Options for views.range() */
export interface OKDBBucketRangeOptions {
    /** Lower bound. ISO string, epoch ms, or Date for time-preset views; bucket key string for custom-projection views. */
    from?: string | number | Date | null;
    /** Upper bound (inclusive). Same shape as from. */
    to?: string | number | Date | null;
    /** Must match the view's configured granularity if provided. */
    granularity?: string;
    /** When true, includes the bucket containing Date.now(). Default false. */
    includePartial?: boolean;
    /** Pagination controls applied to any grouped ($countBy) reducer in the result. */
    preview?: OKDBViewPreviewOptions;
}

/** A single entry in the array returned by views.range() */
export interface OKDBBucketRangeEntry {
    /** Canonical string key for this bucket (ISO date string for preset:'time'). */
    bucketKey: string;
    granularity: string;
    /** Per-reducer aggregated values. Scalar → { value: N }; $countBy → { totalGroups, preview, hasMore, cursor }. */
    reducers: Record<string, OKDBScalarResult | OKDBCountByResult>;
    /** Per-$ref sub-view aggregated values. */
    refs: Record<string, Record<string, OKDBScalarResult | OKDBCountByResult>>;
}

/** Options for views.listBuckets() */
export interface OKDBListBucketsOptions {
    /** Required. Must equal the view's configured granularity. */
    granularity: string;
    from?: string | number | Date | null;
    to?: string | number | Date | null;
    /** Cap the number of results returned. */
    limit?: number;
    /** When true, returns latest-first. Default false (oldest-first). */
    reverse?: boolean;
}

/** A single entry in the array returned by views.listBuckets() */
export interface OKDBBucketEntry {
    /** Canonical string key for this bucket. */
    bucketKey: string;
    /** Number of source documents that fall in this bucket. */
    count: number;
}

/** View definition passed to views.create() */
export interface OKDBViewDefinition {
    /** Source type. Must be registered in this environment. */
    type: string;
    /** Optional sift-style filter. Only matching docs contribute to the view. */
    filter?: OKDBFilter;
    /** Optional declarative transform applied to each doc before reducers run. */
    map?: OKDBViewMap;
    /** Required, non-empty. Maps output field names to reducer specs. */
    reduce: Record<string, OKDBReducerSpec>;
    /**
     * Optional. Enables per-bucket aggregation.
     * Use preset:'time' for time-series bucketing (works over HTTP and in synced envs).
     * Use project for custom string-key bucketing (JS SDK only, not syncable).
     */
    bucket?: OKDBBucketConfig;
}

/** Shape returned for a scalar reducer output ($count, $sum, $avg, $min, $max) */
export interface OKDBScalarResult {
    value: number | null;
    /** Present when items:true was set — returns the live source docs for this bucket */
    items?: () => unknown[];
}

/** Pagination controls for a grouped ($countBy) reducer's preview page */
export interface OKDBViewPreviewOptions {
    /** Max groups per page. Default 50. */
    limit?: number;
    /** Sort direction. Default 'desc' for $countBy (by count). */
    order?: 'asc' | 'desc';
    /** Sort axis. Default 'count' for $countBy. */
    axis?: string;
    /** Opaque cursor from a previous page's `cursor` field. */
    cursor?: string;
    /** Per-reducer override, keyed by the reduce field name. */
    perReducer?: Record<string, { limit?: number; order?: 'asc' | 'desc'; axis?: string; cursor?: string }>;
}

/** A single group entry within a $countBy preview page */
export interface OKDBCountByPreviewEntry {
    key: string;
    value: number;
    /** Present when items:true was set — returns the live source docs for this group */
    items?: () => unknown[];
}

/**
 * Shape returned for a $countBy reducer output.
 * Paginated — `preview` holds at most `limit` groups (default 50), sorted by
 * count descending. Pass `{ preview: { limit, order, axis, cursor } }` to
 * views.get()/range() to page through the rest via `hasMore`/`cursor`.
 */
export interface OKDBCountByResult {
    totalGroups: number;
    preview: OKDBCountByPreviewEntry[];
    hasMore: boolean;
    cursor: string | null;
}

/** Shape returned for a $ref slot */
export type OKDBRefResult = Record<string, OKDBScalarResult | OKDBCountByResult>;

/** The full output object returned by views.get() */
export type OKDBViewOutput = Record<string, OKDBScalarResult | OKDBCountByResult | OKDBRefResult>;

/** View lifecycle meta returned by views.getMeta() */
export interface OKDBViewMeta {
    state: 'creating' | 'ready' | 'halted' | 'stopped' | 'resetting';
    clock: number;
    error: { clock: number; key: string; error: string } | null;
    refs: Record<string, { state: string; clock: number; error: string | null }>;
    /** Present on bucketed views. Tracks documents whose bucket field could not be parsed. */
    bucketing?: { unbucketedCount: number };
}

/** Stored view definition returned by views.getDefinition() (includes name and createdAt) */
export type OKDBStoredViewDefinition = OKDBViewDefinition & { name: string; createdAt: number };

/** Options for views.remove() */
export interface OKDBViewRemoveOptions {
    /**
     * How to handle indexes auto-created by this view.
     * Required when the view owns indexes that would otherwise become orphaned.
     * - 'drop'  — drop the index
     * - 'keep'  — retain the index (it becomes unowned)
     */
    managedIndexes?: 'drop' | 'keep';
}

/** Custom reducer registration */
export interface OKDBCustomReducer {
    apply(state: unknown, before: unknown, after: unknown, opts: unknown): unknown;
}

export declare class OKDBViews {
    /**
     * Create a new materialized view. The source type must already be registered.
     * Synchronously bootstraps existing documents then registers an incremental processor.
     */
    create(name: string, definition: OKDBViewDefinition): Promise<{ name: string }>;

    /**
     * Read the current view output. Synchronous and O(1).
     * Returns null if the view does not exist.
     */
    get(name: string, options?: { preview?: OKDBViewPreviewOptions }): OKDBViewOutput | null;

    /**
     * Get view lifecycle meta (state, clock, error).
     * Returns null if the view does not exist.
     */
    getMeta(name: string): OKDBViewMeta | null;

    /**
     * Get the stored view definition.
     * Returns null if the view does not exist.
     */
    getDefinition(name: string): Promise<OKDBStoredViewDefinition | null>;

    /** List all view names in this environment. */
    list(): Promise<string[]>;

    /**
     * Remove a view. Pass managedIndexes when the view owns auto-created indexes.
     */
    remove(name: string, options?: OKDBViewRemoveOptions): Promise<void>;

    /** Clears all accumulated state and re-scans from scratch. */
    rebuild(name: string): Promise<void>;

    /** Pause the view. Writes that arrive while stopped are replayed on start(). */
    stop(name: string): Promise<void>;

    /**
     * Resume a stopped (or halted) view.
     * Optimistically catches up with new inserts; performs a full rebuild otherwise.
     */
    start(name: string): Promise<void>;

    /**
     * Register a custom reducer. Must be called before creating any view that uses it.
     * The name must start with '$' and must not conflict with a built-in reducer.
     */
    registerReducer(name: string, reducer: OKDBCustomReducer): void;

    /**
     * Query per-bucket aggregates for a bucketed view.
     * Returns a sparse ordered array — only buckets with at least one document are included.
     * Returns null if the view does not exist.
     * Throws VIEW_NOT_BUCKETED if the view was not created with a bucket config.
     */
    range(name: string, options?: OKDBBucketRangeOptions): OKDBBucketRangeEntry[] | null;

    /**
     * List populated bucket keys for a bucketed view, with per-bucket document counts.
     * options.granularity is required and must equal the view's configured granularity.
     * Throws VIEW_NOT_FOUND if the view does not exist.
     * Throws VIEW_NOT_BUCKETED if the view was not created with a bucket config.
     */
    listBuckets(name: string, options: OKDBListBucketsOptions): OKDBBucketEntry[];

    /** @internal Called by OKDB after sync to activate views that arrived from peers. */
    bootSyncedViews(): Promise<void>;
}
