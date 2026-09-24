import type { OKDBEnvironment } from '../environment';

/**
 * The trailing `env` argument: an environment OBJECT (e.g. `db.env('name')`); omitted = the
 * default env. A name string is NOT accepted.
 */
export type OKDBFtsEnvArg = OKDBEnvironment;

/** Tokenizer settings. Defaults: min 2, max 64 (longer tokens truncated), keepNumbers true, toLower true. */
export interface OKDBFtsTokenizerOptions {
    minTokenLength?: number;
    maxTokenLength?: number;
    keepNumbers?: boolean;
    toLower?: boolean;
    stopwords?: string[];
}

export interface OKDBFtsConfig {
    /** Non-empty list of field paths to index. */
    fields: string[];
    tokenizer?: OKDBFtsTokenizerOptions;
}

/** Persisted status of one FTS index. */
export type OKDBFtsIndexStatus = 'creating' | 'resetting' | 'ready' | 'waiting' | 'dropping' | 'error';

export interface OKDBFtsListEntry {
    name: string;
    status: OKDBFtsIndexStatus | null;
    config: OKDBFtsConfig | null;
    created: number | null;
    updated: number | null;
    error: { message: string; timestamp: number } | null;
    /**
     * Per-TYPE async processor state. Repeated identically on every entry of the same type.
     * Reflects the single processor that drives all FTS indexes on this type.
     */
    processorState: 'building' | 'online' | 'error' | 'waiting' | null;
    /**
     * Per-TYPE number of changes the async processor has not yet indexed. Repeated identically
     * on every entry of the same type. 0 = caught up.
     */
    lag: number | null;
    /** Approximate bytes stored for this index (excludes env-level shared dictionaries). */
    sizeBytes: number;
}

/** An FTS index as reported by fts.list(). Alias of {@link OKDBFtsListEntry}. */
export type OKDBFtsIndex = OKDBFtsListEntry;

export interface OKDBFtsSearchOptions {
    /** Max results (integer >= 1). Default 50. */
    limit?: number;
    /** 'and' (default): every query token must match; 'or': any token, ranked by score. */
    mode?: 'and' | 'or';
    /** Match query tokens as prefixes (an exact word scores above a prefix-only completion). */
    prefix?: boolean;
}

/** One hydrated hit from fts.searchDocs(). */
export interface OKDBFtsSearchResult {
    key: string;
    /** The document, or null if it vanished between search and hydration. */
    value: unknown;
    version: number | null;
    /** BM25 relevance score (higher = more relevant). */
    score: number | null;
    /** Number of unique query tokens. */
    numTerms: number;
    /** The query's BM25 upper bound (Σ idf·(k1+1)); score / maxScore ∈ (0, 1). */
    maxScore: number;
}

/** A searchDocs() hit. Alias of {@link OKDBFtsSearchResult}. */
export type OKDBFtsQueryResult = OKDBFtsSearchResult;

/** Return of fts.envSize(). */
export interface OKDBFtsEnvSize {
    /** ~fts/<env>/ + ~fts/<env>_docs/ data.mdb file sizes. */
    diskBytes: number;
    /** Stored bytes (index payloads + shared dictionaries). */
    payloadBytes: number;
    indexPayloadBytes: number;
    sharedDictBytes: number;
    /** LMDB free pages (reclaimable). */
    slackBytes: number;
    indexes: Array<{ type: string; name: string; sizeBytes: number }>;
}

/** Return of fts.compactStorage(). */
export interface OKDBFtsCompactResult {
    ok: true;
    sizeBefore: number;
    sizeAfter: number;
    saved: number;
    savedPct: number;
}

/**
 * Full-text search (`db.fts`). Every method takes an optional trailing `env` — an environment
 * OBJECT (e.g. `db.env('name')`), not a name string; omitted = the 'default' env.
 */
export declare class OKDBFts {
    /**
     * Register a new FTS index on a type. The build runs in the background; await ready(type).
     * Throws ALREADY_EXISTS, INVALID_FTS, or a type-not-registered error.
     */
    register(type: string, name: string, config: OKDBFtsConfig, timestamp?: number, env?: OKDBFtsEnvArg): Promise<void>;

    /** Idempotent register — no-op if an index with this name already exists (config is not compared). */
    ensure(type: string, name: string, config: OKDBFtsConfig, env?: OKDBFtsEnvArg): Promise<void>;

    /** Drop an FTS index. No-op if it does not exist. Storage is reclaimed in the background. */
    drop(type: string, name: string, env?: OKDBFtsEnvArg): Promise<void>;

    /** Rebuild an FTS index in the background (`clear` defaults to true). Throws NOT_FOUND. */
    reset(type: string, name: string, clear?: boolean, env?: OKDBFtsEnvArg): Promise<void>;

    /** Returns true if the FTS index exists. */
    has(type: string, name: string, env?: OKDBFtsEnvArg): boolean;

    /** Returns the index status, or null if not registered. */
    status(type: string, name: string, env?: OKDBFtsEnvArg): OKDBFtsIndexStatus | null;

    /** List all FTS indexes for a type. */
    list(type: string, env?: OKDBFtsEnvArg): OKDBFtsListEntry[];

    /**
     * Resolves true when all FTS indexes on the type finish their build. Rejects with
     * FTS_BUILD_FAILED if a build failed (reset() retries). `name` is accepted but ignored.
     */
    ready(type: string, name?: string, env?: OKDBFtsEnvArg): Promise<boolean>;

    /**
     * Waits for the type's FTS processor to reach the current write position (or error), then
     * compacts the live tier into the frozen tier. Use when a write must be searchable immediately.
     */
    flush(type: string, env?: OKDBFtsEnvArg): Promise<void>;

    /** Roll every live-tier posting of the type's indexes into the frozen tier (flush() does this). */
    compact(type: string, env?: OKDBFtsEnvArg): Promise<void>;

    /** Env-level FTS storage summary. */
    envSize(env?: OKDBFtsEnvArg): OKDBFtsEnvSize;

    /** Rewrite the env's ~fts store files to reclaim LMDB slack (env.compact() calls this). */
    compactStorage(env?: OKDBFtsEnvArg): Promise<OKDBFtsCompactResult>;

    /** Search an index. Returns matching document keys (at most `limit`, default 50). Throws NOT_FOUND. */
    search(type: string, name: string, query: string, options?: OKDBFtsSearchOptions, env?: OKDBFtsEnvArg): string[];

    /** Search and return hydrated documents with scores. */
    searchDocs(
        type: string,
        name: string,
        query: string,
        options?: OKDBFtsSearchOptions & { keysOnly?: false },
        env?: OKDBFtsEnvArg,
    ): OKDBFtsSearchResult[];
    /** `keysOnly: true` behaves exactly like search(). */
    searchDocs(
        type: string,
        name: string,
        query: string,
        options: OKDBFtsSearchOptions & { keysOnly: true },
        env?: OKDBFtsEnvArg,
    ): string[];
}
