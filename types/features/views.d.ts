/** Sift-style (MongoDB-compatible) filter object */
export type OKDBFilter = Record<string, unknown>;

/** Map operator specs */
/**
 * FK lookup: `[type, fkField, targetField]`. `fkField` starting with `$` is a path on the source doc;
 * otherwise it is a literal key. `live: true` maintains an inverse index so changes to the referenced
 * doc re-evaluate every source doc pointing at it (default: resolved once at write time).
 */
export type OKDBMapRefSpec = { $ref: [type: string, fkField: string, targetField: string]; live?: boolean };
export type OKDBMapConcatSpec = { $concat: string[] };
export type OKDBMapCoalesceSpec = { $coalesce: string[] };
export type OKDBMapFieldSpec = string | OKDBMapRefSpec | OKDBMapConcatSpec | OKDBMapCoalesceSpec;

/** Declarative per-doc transform merged onto source docs before reducers run */
export type OKDBViewMap = Record<string, OKDBMapFieldSpec>;

/**
 * Options shared by every reducer spec.
 * - `items: true` exposes an `items()` accessor on the reducer's output (live source docs).
 * - `filter` is a per-reducer sift-style filter applied after the view filter + map.
 */
export interface OKDBReducerCommon {
    items?: boolean;
    filter?: OKDBFilter;
}

/** Built-in reducer specs */
export type OKDBCountSpec = { $count: true } & OKDBReducerCommon;
export type OKDBSumSpec = { $sum: string } & OKDBReducerCommon;
export type OKDBAvgSpec = { $avg: string } & OKDBReducerCommon;
/** Index-backed: auto-creates (or reuses) a single-field index on the field. Not supported inside `$ref`. */
export type OKDBMinSpec = { $min: string } & OKDBReducerCommon;
/** Index-backed: auto-creates (or reuses) a single-field index on the field. Not supported inside `$ref`. */
export type OKDBMaxSpec = { $max: string } & OKDBReducerCommon;
export type OKDBCountBySpec = { $countBy: string } & OKDBReducerCommon;
/**
 * `$group`: partitions docs by `by` (single field or compound key) and runs named sub-reducers per group.
 * `$ref` is not allowed inside `reduce`; `$min`/`$max` are not allowed inside a nested `$group`.
 */
export type OKDBGroupSpec = {
    $group: {
        by: string | string[];
        filter?: OKDBFilter;
        reduce: Record<string, OKDBReducerSpec>;
    };
} & OKDBReducerCommon;
/** A reducer registered via views.registerReducer() / OKDB.registerViewReducer() — `{ $name: opts }`. */
export type OKDBCustomSpec = { [reducer: string]: unknown; items?: boolean; filter?: OKDBFilter };

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
    | OKDBGroupSpec
    | { $ref: OKDBRefSpec }
    | OKDBCustomSpec;

/** Allowed granularity values for preset:'time' bucket configs */
export type OKDBBucketTimeGranularity = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * Bucket configuration for bucketed views.
 * Use preset:'time' for time-series bucketing.
 * Use project for custom string-key bucketing: the NAME of a projection registered with
 * OKDB.registerBucketProjection() (a function can't be persisted and is refused).
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
          /**
           * Name of a projection registered with OKDB.registerBucketProjection(name, fn), which maps a
           * field value to a string bucket key. Every process that opens the store must register it.
           */
          project: string;
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
    /** Per-reducer aggregated values. Scalar → { value: N }; $countBy/$group → { totalGroups, preview, hasMore, cursor }. */
    reducers: Record<string, OKDBScalarResult | OKDBGroupedResult>;
    /** Per-$ref sub-view aggregated values. */
    refs: Record<string, Record<string, OKDBScalarResult | OKDBGroupedResult>>;
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
     * Use preset:'time' for time-series bucketing.
     * Use project (a registered projection name) for custom string-key bucketing.
     */
    bucket?: OKDBBucketConfig;
    /** Maintenance timing. Default 'sync' (updated in the writer's commit). */
    mode?: 'sync' | 'async';
}

/** Options for an `items()` accessor on a view output. */
export interface OKDBViewItemsOptions {
    /** Scope to one bucket of a bucketed view. `granularity` must equal the view's. */
    bucket?: { granularity: string; key: string };
    limit?: number;
    /** Resume after this doc key (a previous page's `lastKey`). */
    startKey?: string;
    reverse?: boolean;
    offset?: number;
    /** Return doc keys instead of `{ key, value }` entries (paginated form only). */
    keysOnly?: boolean;
}

/** One page returned by a paginated `items()` call. */
export interface OKDBViewItemsPage {
    /** `{ key, value }` entries, or doc keys when `keysOnly: true`. */
    result: Array<{ key: string; value: unknown }> | string[];
    hasMore: boolean;
    lastKey: string | null;
}

/**
 * `items()` accessor attached to view outputs when a reducer sets `items: true`.
 * With no options (or only `bucket`) returns the source docs as a flat array; any pagination
 * option (`limit`/`startKey`/`reverse`/`offset`/`keysOnly`) returns an {@link OKDBViewItemsPage}.
 */
export interface OKDBViewItemsFn {
    (options?: { bucket?: { granularity: string; key: string } }): unknown[];
    (options: OKDBViewItemsOptions): unknown[] | OKDBViewItemsPage;
}

/** Shape returned for a scalar reducer output ($count, $sum, $avg, $min, $max, custom) */
export interface OKDBScalarResult {
    /** Reducer value; custom reducers may return non-numeric state. */
    value: unknown;
    /** Present when items:true was set — returns the live source docs */
    items?: OKDBViewItemsFn;
}

/** Pagination controls for a grouped ($countBy) reducer's preview page */
export interface OKDBViewPreviewOptions {
    /** Max groups per page. Default 50. */
    limit?: number;
    /** Sort direction. Default 'desc' ('asc' when axis is 'key'). */
    order?: 'asc' | 'desc';
    /**
     * Sort axis for `$group`: a sub-reducer name or 'key' (default: first non-index-backed scalar
     * sub-reducer, else 'key'). Ignored for `$countBy`, which always sorts by count.
     */
    axis?: string;
    /** Opaque cursor from a previous page's `cursor` field. */
    cursor?: string;
    /** Per-reducer override, keyed by the reduce field name. */
    perReducer?: Record<string, { limit?: number; order?: 'asc' | 'desc'; axis?: string; cursor?: string }>;
}

/** A single group entry within a $countBy preview page */
export interface OKDBCountByPreviewEntry {
    /** Group key (stringified field value). */
    key: string;
    value: number;
    /** Present when items:true was set — returns the live source docs for this group */
    items?: OKDBViewItemsFn;
}

/**
 * A single group entry within a $group preview page: `{ key, <subReducer>: { value }, ... }`.
 * Compound `by` keys are joined with '\x00'. Nested grouped sub-reducers are omitted.
 */
export interface OKDBGroupPreviewEntry {
    key: string;
    items?: OKDBViewItemsFn;
    [subReducer: string]: OKDBScalarResult | OKDBViewItemsFn | string | undefined;
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

/** Shape returned for a $group reducer output (same pagination as $countBy). */
export interface OKDBGroupResult {
    totalGroups: number;
    preview: OKDBGroupPreviewEntry[];
    hasMore: boolean;
    cursor: string | null;
}

/** Output of a grouped reducer ($countBy or $group). */
export type OKDBGroupedResult = OKDBCountByResult | OKDBGroupResult;

/** Shape returned for a $ref slot */
export interface OKDBRefResult {
    /** Present when the ref has an items-enabled reducer — the live child docs. */
    items?: OKDBViewItemsFn;
    [reducer: string]: OKDBScalarResult | OKDBGroupedResult | OKDBViewItemsFn | undefined;
}

/**
 * The full output object returned by views.get(): one key per `reduce` entry, plus a
 * view-level `items()` accessor when any reducer sets `items: true`.
 */
export interface OKDBViewOutput {
    items?: OKDBViewItemsFn;
    [reducer: string]: OKDBScalarResult | OKDBGroupedResult | OKDBRefResult | OKDBViewItemsFn | undefined;
}

/** Aggregate lifecycle state of a view. */
/** 'error' = a stored definition that could not be compiled at open() (held back, never activated). */
export type OKDBViewState = 'creating' | 'partially-ready' | 'ready' | 'halted' | 'stopped' | 'resetting' | 'error';

/** Bootstrap progress of the section currently scanning. */
export interface OKDBViewBootstrapProgress {
    processed: number;
    total: number | null;
    percent: number | null;
}

/** Per-section bootstrap state (primary type + each $ref). */
export interface OKDBViewSectionState {
    state: string;
    clock: number;
    progress: OKDBViewBootstrapProgress | null;
}

/** View lifecycle meta returned by views.getMeta() */
export interface OKDBViewMeta {
    state: OKDBViewState;
    clock: number;
    /** Halt cause ({clock, key, error}), or {code, error} for a held-back ('error') view. */
    error: { clock?: number; key?: string; code?: string | null; error: string } | null;
    refs: Record<string, { state: string; clock: number; error: unknown }>;
    /** Persisted storage layout version; a mismatch auto-rebuilds on open. */
    storageVersion?: number;
    /** Per-section bootstrap state. Present once a bootstrap has run. */
    sections?: {
        primary?: OKDBViewSectionState;
        refs?: Record<string, OKDBViewSectionState>;
    };
    /** Derived from `sections` — progress of the section still creating, else null. */
    bootstrapProgress?: OKDBViewBootstrapProgress | null;
    /** Present on bucketed views. Tracks documents whose bucket field could not be parsed. */
    bucketing?: { unbucketedCount: number };
}

/**
 * Payload of the `'view:progress'` event (EVENTS.VIEW_PROGRESS) emitted on `env.events`
 * during view bootstrap.
 */
export interface OKDBViewProgressEvent {
    name: string;
    phase: 'scan' | 'replay' | 'ref-scan' | 'ref-replay';
    /** 'primary' or `refs.<refName>`. */
    section: string;
    refName?: string;
    processed: number;
    total: number | null;
    percent: number | null;
}

/** Stored view definition returned by views.getDefinition() */
export type OKDBStoredViewDefinition = OKDBViewDefinition & {
    name: string;
    createdAt: number;
    /** Set once the initial bootstrap completed. */
    readyAt?: number;
};

/** Options for views.itemsGroups() */
export interface OKDBViewItemsGroupsOptions {
    /** Name of a grouped ($countBy / $group) reducer. Required. */
    reducerName: string;
    /** Look the reducer up inside this $ref slot. */
    refName?: string;
    /** Bucket key (default: the unbucketed '_' aggregate). */
    bucket?: string;
    /** 'count' ($countBy), a $group sub-reducer name, or 'key'. Same defaults as preview. */
    axis?: string;
    order?: 'asc' | 'desc';
    /** Page size. Default 100, clamped to 1..1000. */
    limit?: number;
    /** Opaque cursor from a previous page. */
    cursor?: string;
}

/** One page returned by views.itemsGroups() */
export interface OKDBViewItemsGroupsPage {
    /** $countBy: `{ key, value }`; $group: `{ key, <subReducer>: { value }, ... }`. */
    items: Array<OKDBCountByPreviewEntry | OKDBGroupPreviewEntry>;
    totalGroups: number;
    hasMore: boolean;
    cursor: string | null;
}

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

/** Materialized views for one environment (`env.views`). */
export declare class OKDBViews {
    /**
     * Create a new materialized view. The source type must already be registered.
     * Bootstraps existing documents cooperatively (emits 'view:progress' on `env.events`) then
     * registers the incremental processor. Resolves when ready. An interrupted bootstrap is not
     * resumed: the next open() rebuilds the view from scratch.
     */
    create(name: string, definition: OKDBViewDefinition): Promise<{ name: string }>;

    /**
     * Read the current view output. Synchronous and O(1).
     * Returns null if the view does not exist.
     */
    get(name: string, options?: { preview?: OKDBViewPreviewOptions }): OKDBViewOutput | null;

    /**
     * Paginate ALL groups of a grouped reducer ($countBy / $group), ordered by any leaderboard axis.
     * Throws VIEW_NOT_FOUND, VIEW_ITEMS_REDUCER_NOT_FOUND, VIEW_ITEMS_REDUCER_NOT_GROUPED, CURSOR_INVALID.
     */
    itemsGroups(name: string, options: OKDBViewItemsGroupsOptions): OKDBViewItemsGroupsPage;

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

    /** Clears all accumulated state and re-scans from scratch. Throws VIEW_NOT_FOUND. */
    rebuild(name: string): Promise<void>;

    /**
     * Wipe the view's state and re-run the bootstrap scan in place, leaving its live
     * handlers registered. Prefer rebuild(). Throws VIEW_NOT_FOUND.
     */
    resetView(name: string): Promise<void>;

    /** Pause the view. Writes that arrive while stopped are replayed on start(). */
    stop(name: string): Promise<void>;

    /**
     * Resume a stopped (or halted) view.
     * Optimistically catches up with new inserts; performs a full rebuild otherwise.
     */
    start(name: string): Promise<void>;

    /**
     * Register a custom reducer for this env. Must be called before creating any view that uses it.
     * The name must start with '$' and must not be a built-in reducer or `$ref`.
     * A stored view held back at open() because this reducer wasn't registered is re-derived now.
     * Prefer OKDB.registerViewReducer() before open() so such views are live from boot.
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
}
