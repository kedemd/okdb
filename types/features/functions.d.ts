/** Runtime limits of a stored function (normalized; defaults come from the `functions` constructor option). */
export interface OKDBFunctionRuntime {
    /** Run deadline in ms (default 5000). Exposed to the script as `ctx.signal`. */
    timeoutMs: number;
    /** Sandbox heap cap in MB (default 32). */
    memoryMb: number;
    /** Whether the script may use `fetch` (default true). */
    allowFetch: boolean;
    pool: string | null;
}

/** Input accepted by `create()`, `update()` (as a patch) and `preview()`. */
export interface OKDBFunctionDefinition {
    /** Must match `/^[A-Za-z0-9._-]+$/`. Required for `create()`; `update()` uses its `name` argument. */
    name?: string;
    /**
     * Script source: a single function expression `[async] (ctx) => { ... }` (max 64 KiB; must not
     * reference `require`/`import`/`console`/`module`/`exports`/`process`). Allowed `ctx` props:
     * payload, info, signal, log, env, job, processor, materializer (+ `okdb` when `unsafe: true`).
     */
    source?: string;
    /** Alternative to `source` (`script.source` wins). */
    script?: { source?: string };
    runtime?: Partial<OKDBFunctionRuntime>;
    /** Grants `ctx.okdb` (privileged root facade with cross-env access). Default false. */
    unsafe?: boolean;
    /** Default true. A disabled function throws `FUNCTION_DISABLED` on `run()` / `preview()`. */
    enabled?: boolean;
    /** Explicit version; defaults to 1 on create and previous + 1 on update. */
    version?: number;
    metadata?: {
        description?: string | null;
        tags?: string[];
        createdBy?: string | null;
        updatedBy?: string | null;
        [key: string]: unknown;
    };
}

/** Stored function record (`~functions` type in the owning env). */
export interface OKDBFunctionRecord {
    name: string;
    /** Always `'env'`. */
    scope: 'env';
    unsafe: boolean;
    enabled: boolean;
    version: number;
    /** `sha256:<hex>` of the normalized source. */
    hash: string;
    runtime: OKDBFunctionRuntime;
    script: { language: 'javascript'; source: string; bytes: number };
    metadata: {
        description: string | null;
        tags: string[];
        createdAt: number;
        updatedAt: number;
        createdBy: string | null;
        updatedBy: string | null;
        /** Engine/pipeline linkage, set when a function is owned by an engine or pipeline. */
        owner_engine?: unknown;
        pipeline?: unknown;
    };
}

/** Row shape returned by `list()` / `listRuns()`. */
export interface OKDBFunctionRegistryEntry<T> {
    key: string;
    value: T;
    version: number;
}

export type OKDBFunctionRunStatus = 'queued' | 'running' | 'success' | 'error' | 'timeout' | 'killed';

export interface OKDBFunctionLogEntry {
    level: string;
    msg: string;
    meta: Record<string, unknown> | null;
    context: unknown;
    ts: number;
}

export interface OKDBFunctionDryRunAction {
    scope: string;
    method: string;
    envName: string | null;
    args: unknown[];
}

/** A function run record (`~function_runs` type in the owning env). */
export interface OKDBFunctionRun {
    id: string;
    functionName: string;
    /** `'global'` only appears on legacy records. */
    scope: 'env' | 'global';
    status: OKDBFunctionRunStatus;
    request: { payload: unknown; trigger: string; requestedAt: number };
    execution: {
        runnerId: string | null;
        startedAt: number | null;
        finishedAt: number | null;
        durationMs: number | null;
        timeoutMs: number | null;
        memoryMb: number | null;
    };
    result: {
        /** The script's return value (JSON-cloned). */
        value?: unknown;
        truncated: boolean;
        /** Only on `dryRun` runs: the writes the script attempted (captured, not executed). */
        dryRunActions?: OKDBFunctionDryRunAction[];
    };
    logs: OKDBFunctionLogEntry[];
    error: { message: string; code: string | null; details: unknown; stack: string | null } | null;
    metadata: { env: string | null; functionVersion: number | null; preview: boolean };
}

export interface OKDBFunctionRunOptions {
    /** Capture writes into `result.dryRunActions` instead of committing them. Reads still execute. */
    dryRun?: boolean;
    /** Which runs to persist to `~function_runs` (default `'all'`). */
    recordRuns?: 'all' | 'errors' | 'none';
    /** Recorded as `request.trigger` / `ctx.info.trigger` (default `'sdk'`). */
    trigger?: string;
    /**
     * Per-call run deadline in ms, overriding the stored `runtime.timeoutMs` for this run only
     * (drives `ctx.signal` and the sandbox watchdog; recorded as `execution.timeoutMs`). Must be a
     * positive finite number (else `FUNCTION_INVALID_TIMEOUT`); capped at 600 000 ms
     * (`OKDB_FN_MAX_TIMEOUT_MS`).
     */
    timeoutMs?: number;
}

export interface OKDBFunctionPreviewOptions {
    dryRun?: boolean;
    /** Recorded as `request.trigger` (default `'preview'`). */
    trigger?: string;
    runId?: string;
    /** Name used when the draft definition has none (default `'__draft__'`). */
    functionName?: string;
    /** Filename used in compile-error stack traces. */
    filename?: string;
}

/**
 * Stored, versioned, validated JavaScript functions, executed on the calling node in its
 * per-process sandbox thread.
 *
 * Attached as `env.functions` (registry = that env) and `db.functions` (registry = the `~system`
 * env). Both expose the same surface; run records go to the owning env's `~function_runs`.
 *
 * Removed: `register`, `unregister`, `call` (not part of the 2.x API; use `create`, `remove`, `run`).
 */
export declare class OKDBFunctions {
    /** Name of the env that owns this registry (`'~system'` for `db.functions`). */
    readonly envName: string | null;

    /** All stored functions (empty until the first `create()`). */
    list(): Promise<Array<OKDBFunctionRegistryEntry<OKDBFunctionRecord>>>;
    get(name: string): Promise<OKDBFunctionRecord | null>;
    /** Validates and stores a new function. Throws if the name already exists or the script is invalid. */
    create(definition: OKDBFunctionDefinition & { name: string }): Promise<OKDBFunctionRecord>;
    /** Patches an existing function; fields not given are kept, version bumps. Throws if missing. */
    update(name: string, patch?: OKDBFunctionDefinition): Promise<OKDBFunctionRecord>;
    /** Resolves false if the function did not exist. */
    remove(name: string): Promise<boolean>;

    /**
     * Runs a stored function and resolves with the final run record (`result.value` = return value).
     * Rejects on script error / timeout (`err.code` e.g. `FUNCTION_TIMEOUT`, `FUNCTION_DISABLED`).
     */
    run(name: string, payload?: unknown, options?: OKDBFunctionRunOptions): Promise<OKDBFunctionRun>;
    /** Validates and runs an unsaved draft. Persists neither the definition nor a run record. */
    preview(
        definition: OKDBFunctionDefinition,
        payload?: unknown,
        options?: OKDBFunctionPreviewOptions,
    ): Promise<OKDBFunctionRun>;

    listRuns(options?: { functionName?: string | null }): Promise<Array<OKDBFunctionRegistryEntry<OKDBFunctionRun>>>;
    getRun(runId: string): Promise<OKDBFunctionRun | null>;
    /** Low-level: normalizes and writes a run record to `~function_runs` (`run()` does this itself). */
    recordRun(run?: Partial<OKDBFunctionRun>): Promise<OKDBFunctionRun>;
}
