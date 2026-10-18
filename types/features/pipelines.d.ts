import type { OKDBEnvironment } from '../environment';
import type { OKDBEngine, OKDBEngineStatus } from './engines';
import type { OKDBEmbeddingsVectorSpace } from './embeddings';

// ─── Records ──────────────────────────────────────────────────────────────────

export type OKDBPipelineStatus = 'active' | 'stopped';

/** A member reference: an existing engine playing a named role. Order is meaningful. */
export interface OKDBPipelineMemberRef {
    /** Engine type (e.g. `'indexer'`, `'queue-worker'`). */
    type: string;
    /** Engine name. */
    name: string;
    /** Role within the pipeline (e.g. `'embedder'`, `'indexer'`, `'search'`, `'worker'`). */
    role: string;
}

/**
 * Input to `env.pipelines.create()` / `validate()`. Every referenced engine must
 * already exist. Strings are trimmed.
 */
export interface OKDBPipelineDefinition {
    name: string;
    /** Must be `null` (V1). */
    template?: null;
    /** Default `'active'`. */
    status?: OKDBPipelineStatus;
    /**
     * Plain object. Known keys: `label`, `family` (`'embeddings'` for embeddings
     * pipelines), `templateId`, `lifecycleSkipRoles` (roles excluded from
     * start/stop, e.g. a shared `embedder`).
     */
    meta?: Record<string, unknown>;
    /** Non-empty, ordered. */
    engines: OKDBPipelineMemberRef[];
    created?: number;
    updated?: number;
}

/** The normalized record stored in the env's `~pipelines` type (key = `name`). */
export interface OKDBPipelineRecord {
    name: string;
    template: null;
    status: OKDBPipelineStatus;
    meta: Record<string, unknown>;
    created: number;
    updated: number;
    engines: OKDBPipelineMemberRef[];
}

/** Patch for `env.pipelines.update()`. Only `status` / `meta` may change; `engines` must equal the current topology. */
export interface OKDBPipelineUpdatePatch {
    status?: OKDBPipelineStatus;
    meta?: Record<string, unknown>;
    /** Accepted only if identical to the current members (topology is immutable). */
    engines?: OKDBPipelineMemberRef[];
    [key: string]: unknown;
}

/** Raw record entry from `listRecords()`; `env` is set only on the `db.pipelines` aggregate. */
export interface OKDBPipelineRecordEntry {
    env?: string;
    key: string;
    value: OKDBPipelineRecord;
    version: number;
}

// ─── Inspection ───────────────────────────────────────────────────────────────

/**
 * Per-member state: an engine runtime status, `'remote'` (durable record present
 * but not running in this process — e.g. an `engines: false` node), or
 * `'missing'` (no engine anywhere).
 */
export type OKDBPipelineMemberState = OKDBEngineStatus | 'remote' | 'missing';

/** `'stopped'` if the record is stopped; `'online'` if every member is online/remote; `'error'`; else `'degraded'`. */
export type OKDBPipelineHealth = 'online' | 'degraded' | 'error' | 'stopped';

/** A member as returned by `get()` / `list()` — the ref plus live/durable inspection data. */
export interface OKDBPipelineMemberInfo extends OKDBPipelineMemberRef {
    /** `<type>@<name>`, or `null` when missing. */
    key: string | null;
    state: OKDBPipelineMemberState;
    exists: boolean;
    isRunning: boolean;
    status: OKDBEngineStatus | null;
    reason: string | null;
    config: Record<string, unknown> | null;
    meta: Record<string, unknown> | null;
    error: string | null;
    /** Env holding the engine's `~engines` record (live engines only). */
    storeEnv: string | null;
    /** True if the engine is stored in the pipeline's own env. */
    owned: boolean;
    /** Member `api.status()`/`api.stats()` result, durable stats fallback, or the engine's runtimeState. */
    runtime: Record<string, unknown> | null;
    lastClock: number | null;
    headClock: number | null;
    lag: number | null;
    progress: unknown;
    paused: boolean;
    cursorKey: string | null;
}

/** An inspected pipeline, as returned by `get()` / `list()`. */
export interface OKDBPipelineInfo extends Omit<OKDBPipelineRecord, 'engines'> {
    /** Record key (the pipeline name). */
    key: string;
    /** Record version from `list()`; always `null` from `get()`. */
    version: number | null;
    /** Owning env name. */
    env: string | null;
    health: OKDBPipelineHealth;
    /**
     * Embeddings pipelines: the embedder's model changed since the vectors were embedded — search
     * serves the old vectors, new embeds are held until `rebuild()` ("Re-embed all").
     */
    stale?: boolean;
    /** Embeddings pipelines: see `OKDBEmbeddingsVectorSpace`. */
    vector_space?: OKDBEmbeddingsVectorSpace;
    engines: OKDBPipelineMemberInfo[];
}

export interface OKDBPipelineRebuildResult {
    pipeline: string;
    /** Per member key (`<type>@<name>`): the member's `api.rebuild()` result. */
    results: Record<string, unknown>;
    /** Member keys without a rebuild API (or not running here). */
    skipped: string[];
}

export interface OKDBPipelineRemoveResult {
    /** `false` if no such pipeline. */
    removed: boolean;
    /** Env-owned members uninstalled with the pipeline (`<type>@<name>`). */
    enginesRemoved: string[];
    /** Members kept: shared/global, referenced by another pipeline in the env, or not resolvable here. */
    enginesPreserved: string[];
}

/** Result of `findOwner()`. */
export interface OKDBPipelineOwner {
    env: string;
    pipeline: string;
    role: string | null;
}

// ─── Embeddings pipeline handle ───────────────────────────────────────────────

/** Options for `pipeline.api.search()` / `searchDocs()`; extra keys go to the ANN algorithm. */
export interface OKDBPipelineSearchOptions {
    /** Default 10. For `searchDocs` it counts documents, for `search` chunks. */
    limit?: number;
    /** Minimum score (0–1). Default 0. */
    threshold?: number;
    [key: string]: unknown;
}

/** Chunk-level hit: `key` is the raw vec key (`docKey` or `docKey\tchunkHash` for chunked pipelines). */
export interface OKDBPipelineSearchHit {
    key: string;
    /** 0–1, higher = more similar. */
    score: number;
}

/** Document-level hit: best chunk per source doc. */
export interface OKDBPipelineDocHit {
    /** Source document key. */
    key: string;
    score: number;
    /** Hash of the winning chunk (chunked pipelines only). */
    chunkHash?: string;
}

/** `pipeline.api` — convenience API over an embeddings pipeline's members. */
export interface OKDBPipelineApi {
    /** Chunk-level nearest-neighbour search. Text queries are embedded; vectors are used as-is. */
    search(query: string | Float32Array | number[], opts?: OKDBPipelineSearchOptions): Promise<OKDBPipelineSearchHit[]>;
    /** Document-level search: one row per source doc, over-fetching until `limit` docs are found. */
    searchDocs(
        query: string | Float32Array | number[],
        opts?: OKDBPipelineSearchOptions,
    ): Promise<OKDBPipelineDocHit[]>;
    /**
     * Wait (up to 30 s) for the indexer to catch up with the source type's head.
     * Throws if the indexer is not running on this node.
     */
    flush(): Promise<void>;
    /** Combined stats: embedder `health()`, indexer/worker/search `stats()` (`undefined` when not running here). */
    stats(): Promise<{ embedder: unknown; indexer: unknown; worker: unknown; search: unknown }>;
}

/** Returned by `okdb.embeddings.createPipeline(name, config, meta?)`. */
export interface OKDBPipelineHandle {
    embedder: OKDBEngine;
    indexer: OKDBEngine;
    /** Present only for `mode: 'queue'`. */
    worker: OKDBEngine | null;
    search: OKDBEngine;
    api: OKDBPipelineApi;
}

// ─── OKDBPipelines ────────────────────────────────────────────────────────────

/**
 * Generic pipeline registry: env-defined, synced `~pipelines` records grouping
 * existing engines into an ordered, structurally immutable topology ("the
 * pipeline is the engine"). Member add/remove is impossible at runtime; use
 * `replaceMember()` for a same-type swap.
 *
 * Attached twice, one class:
 * - `env.pipelines` — the env-local registry: full CRUD + lifecycle.
 * - `db.pipelines` — coordinator: read-only aggregation across opened envs
 *   (`get`/`getRecord` take `(env, name)` or `(name)` → `'default'`; `list`/
 *   `listRecords` take `{ envName }`), plus `findOwner`. Mutating methods
 *   (`create`, `update`, `start`, `stop`, `restart`, `rebuild`,
 *   `replaceMember`, `remove`) throw here — call them on `db.env(name).pipelines`.
 *
 * Errors are plain `Error`s (no `code`), e.g. "Pipeline not found: …".
 */
export declare class OKDBPipelines {
    /** True on `db.pipelines`, false on `env.pipelines`. */
    readonly isCoordinator: boolean;
    /** Owning env name (`null` on the coordinator). */
    readonly envName: string | null;

    // ── Reads (both surfaces) ─────────────────────────────────────────────────

    /** Inspected pipeline (members + health), or `null`. env: `get(name)`. */
    get(name: string): Promise<OKDBPipelineInfo | null>;
    /** db only: pipeline `name` in env `envName`. */
    get(envName: string, name: string): Promise<OKDBPipelineInfo | null>;
    /** All inspected pipelines. env: that env (options ignored); db: every opened env, or `options.envName`. */
    list(options?: { envName?: string | null }): Promise<OKDBPipelineInfo[]>;
    /** Raw stored record, or `null`. */
    getRecord(name: string): Promise<OKDBPipelineRecord | null>;
    /** db only: raw record `name` in env `envName`. */
    getRecord(envName: string, name: string): Promise<OKDBPipelineRecord | null>;
    /** Raw records. db entries carry `env`. */
    listRecords(options?: { envName?: string | null }): Promise<OKDBPipelineRecordEntry[]>;
    /** Normalize + validate a definition without persisting (throws on invalid input). */
    validate(
        definition: OKDBPipelineDefinition,
        options?: { previous?: OKDBPipelineRecord | null },
    ): OKDBPipelineRecord;
    /** Which pipeline (in any opened user env) owns engine `type@name` as a member, or `null`. */
    findOwner(type: string, name: string): OKDBPipelineOwner | null;
    /** Ensure the `~pipelines` type exists (env: this env; db: `envName`, default `'default'`); returns the env. */
    ensure(envName?: string): Promise<OKDBEnvironment>;

    // ── Mutations (env.pipelines only) ────────────────────────────────────────

    /** Persist a new record. Throws if it exists or references engines not found on this node. */
    create(definition: OKDBPipelineDefinition): Promise<OKDBPipelineInfo>;
    /** Update `status` / `meta`. Throws on any topology change. */
    update(name: string, patch?: OKDBPipelineUpdatePatch): Promise<OKDBPipelineInfo>;
    /** Start managed members (declaration order; `meta.lifecycleSkipRoles` excluded), set status `active`. */
    start(name: string): Promise<OKDBPipelineInfo>;
    /** Stop running managed members (reverse order), set status `stopped`. */
    stop(name: string): Promise<OKDBPipelineInfo>;
    /** `stop()` + `start()`. */
    restart(name: string): Promise<OKDBPipelineInfo>;
    /**
     * Destructive re-derivation: call `api.rebuild()` on every member that has one,
     * in member order (embeddings: wipe + re-embed, then reload the index).
     */
    rebuild(name: string): Promise<OKDBPipelineRebuildResult>;
    /**
     * Swap the member playing `role` for another existing engine of the same type;
     * siblings whose `config[role]` named the old engine are re-pointed and restarted.
     * Does not re-embed — follow with `rebuild()` if output changes.
     */
    replaceMember(name: string, role: string, newEngineName: string): Promise<OKDBPipelineInfo>;
    /** Delete the record and uninstall env-owned members not referenced by another pipeline in the env. */
    remove(name: string): Promise<OKDBPipelineRemoveResult>;
}
