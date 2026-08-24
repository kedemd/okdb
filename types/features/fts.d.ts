export interface OKDBFtsTokenizerOptions {
    minTokenLength?: number;
    maxTokenLength?: number;
    keepNumbers?: boolean;
    toLower?: boolean;
    stopwords?: string[];
}

export interface OKDBFtsConfig {
    fields: string[];
    tokenizer?: OKDBFtsTokenizerOptions;
}

export interface OKDBFtsListEntry {
    name: string;
    status: 'creating' | 'resetting' | 'ready' | 'waiting' | null;
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
}

export interface OKDBFtsSearchOptions {
    limit?: number;
    mode?: 'and' | 'or';
    prefix?: boolean;
}

export interface OKDBFtsSearchResult {
    key: string;
    value: unknown;
    version: number | null;
    score: number | null;
    numTerms: number;
    maxScore: number;
}

export declare class OKDBFts {
    /** Register a new FTS index on a type. Builds in background; await ready(type) to confirm. */
    register(type: string, name: string, config: OKDBFtsConfig, timestamp?: number, env?: unknown): Promise<void>;

    /** Idempotent register — no-op if index already exists. */
    ensure(type: string, name: string, config: OKDBFtsConfig, env?: unknown): Promise<void>;

    /** Drop a FTS index. */
    drop(type: string, name: string, env?: unknown): Promise<void>;

    /** Force-rebuild a FTS index from scratch. */
    reset(type: string, name: string, clear?: boolean, env?: unknown): Promise<void>;

    /** Returns true if the FTS index exists. */
    has(type: string, name: string, env?: unknown): boolean;

    /** Returns the index status, or null if not registered. */
    status(type: string, name: string, env?: unknown): 'creating' | 'resetting' | 'ready' | 'waiting' | null;

    /** List all FTS indexes for a type. */
    list(type: string, env?: unknown): OKDBFtsListEntry[];

    /**
     * Resolves when all FTS indexes for the type finish their initial build.
     * The `name` parameter is accepted for backward compatibility but ignored.
     */
    ready(type: string, name?: string, env?: unknown): Promise<boolean>;

    /**
     * Waits for the FTS processor to catch up to the current write position.
     * Use after writes when immediate search consistency is required.
     */
    flush(type: string, env?: unknown): Promise<void>;

    /** Search the FTS index. Returns an array of matching document keys. */
    search(type: string, name: string, query: string, options?: OKDBFtsSearchOptions, env?: unknown): string[];

    /** Search and return hydrated documents with scores. */
    searchDocs(
        type: string,
        name: string,
        query: string,
        options?: OKDBFtsSearchOptions & { keysOnly?: boolean },
        env?: unknown,
    ): OKDBFtsSearchResult[] | string[];

    /** Wait for all pending FTS operations to complete (used during shutdown). */
    drain(): Promise<void>;
}
