import type { OKDB } from '../okdb';
import type { OKDBEnvironment } from '../environment';

// ─── Status / events ──────────────────────────────────────────────────────────

/** Node-local runtime status of an engine instance (not synced). */
export type OKDBEngineStatus = 'created' | 'online' | 'stopped' | 'inactive' | 'error' | 'removed';

/** Statuses a driver may set through `ctx.updateStatus()`. */
export type OKDBEngineUpdatableStatus = 'online' | 'stopped' | 'inactive' | 'error';

/**
 * Engine lifecycle events, emitted on `okdb.events` as `engine:<event>` with a
 * payload of `{ engine: key, type, name, ...driverPayload }`.
 * (`'error'` is reserved in the enum; the lifecycle itself does not emit it.)
 */
export type OKDBEngineEvent = 'started' | 'stopped' | 'error' | 'installed' | 'uninstalled';

// ─── Persisted declaration ────────────────────────────────────────────────────

/**
 * The persisted engine declaration — the value of an `~engines` record
 * (key `<type>@<name>`), exposed as `engine.doc`. Synced like other env data;
 * runtime state is NOT part of it.
 */
export interface OKDBEngineDefinition {
    /** Driver type (e.g. `'processor'`, `'queue-worker'`, `'indexer'`). */
    type: string;
    /** Driver-specific config (validated by `driver.validate`). */
    config: Record<string, unknown>;
    /** Free-form metadata; drivers checkpoint runtime state here via `ctx.updateMeta`. */
    meta: Record<string, unknown>;
    /** Should this engine run where eligible? `false` keeps it dormant (`inactive`). */
    enabled: boolean;
    /** Mirror of `config.source_env` for admin visibility. */
    source_env: string | null;
    /** Epoch ms the one-time `driver.install` hook completed, or `null`. */
    installedAt: number | null;
    created: number;
    updated: number;
    [key: string]: unknown;
}

/** `{ key, value, version }` entry of the persisted declaration. */
export interface OKDBEngineDocEntry {
    key: string;
    value: OKDBEngineDefinition;
    version: number;
}

/** `engine.runtimeState` — node-local, JSON-safe snapshot. */
export interface OKDBEngineRuntimeState {
    state: OKDBEngineStatus;
    /** e.g. `'running'`, `'stopped'`, `'disabled'`, `'start_error'`, `'lease_not_acquired'`. */
    reason: string;
    /** Last error message, or `null`. */
    error: string | null;
    running: boolean;
    /** Epoch ms of the last runtime state change. */
    updated: number;
}

/** Options for `createEngine` / `createAndStartEngine`. */
export interface OKDBEngineCreateOptions {
    /** Persist the declaration disabled (`enabled: false`). Default `true`. */
    enabled?: boolean;
    [key: string]: unknown;
}

/** Patch accepted by `engine.patchDeclaration()`. */
export interface OKDBEngineDeclarationPatch {
    enabled?: boolean;
    /** Shallow-merged into `meta`; `null` clears it to `{}`. */
    meta?: Record<string, unknown> | null;
    /**
     * Config patch, applied through the driver's `patchConfig()` (throws
     * `ENGINE_CONFIG_PATCH_UNSUPPORTED` if the driver has none), then re-validated.
     */
    config?: Record<string, unknown>;
}

// ─── Engine instance ──────────────────────────────────────────────────────────

/** Runtime API returned by a driver's `start()`; its methods are driver-defined. */
export type OKDBEngineApi = { [method: string]: any };

/**
 * A single engine instance (`<type>@<name>`). Obtained from
 * `engines.getEngine()` / `createEngine()` / `list()` — never constructed directly.
 */
export interface OKDBEngine<TApi = OKDBEngineApi> {
    /** `<type>@<name>`. */
    readonly key: string;
    readonly type: string;
    readonly name: string;
    /** Same as `type`. */
    readonly engineType: string;
    /** Runtime API from the driver's `start()`; `null` when not running on this node. */
    readonly api: TApi | null;
    /** Persisted declaration, or `null` before `load()`. */
    readonly doc: OKDBEngineDefinition | null;
    readonly docEntry: OKDBEngineDocEntry | null;
    /** Declaration flag (`doc.enabled !== false`). */
    readonly enabled: boolean;
    /** True if started successfully and running on this node. */
    readonly isRunning: boolean;
    /** Node-local runtime status. */
    readonly status: OKDBEngineStatus;
    /** Node-local runtime reason. */
    readonly reason: string;
    /** Error that put the engine into `error` state, or `null`. */
    readonly lastError: Error | null;
    readonly runtimeState: OKDBEngineRuntimeState;
    /** The registered driver object (set by `load()`). */
    readonly driver: OKDBEngineDriver | null;

    /** (Re)load the persisted declaration and resolve the driver. Idempotent unless `force`. */
    load(options?: { force?: boolean }): Promise<this>;
    /**
     * Start on this node: runs the one-time `install` hook, then `driver.start()`.
     * Never throws on driver failure — the engine enters `error` state (or stays
     * `inactive` with reason `lease_not_acquired`); recover with `engines.restart()`.
     * A disabled declaration goes `inactive` (reason `disabled`).
     */
    start(): Promise<void>;
    /** Stop on this node (driver `stop()` hook). Safe on a stopped engine. */
    stop(options?: { reason?: string }): Promise<void>;
    /** Persist a declaration patch (enabled / meta / config) with optimistic concurrency. Does not restart. */
    patchDeclaration(patch?: OKDBEngineDeclarationPatch): Promise<this>;
    /** Stop, run `driver.uninstall()`, and delete the declaration. Prefer `engines.uninstallEngine()`. */
    uninstall(): Promise<void>;
}

// ─── Drivers ──────────────────────────────────────────────────────────────────

/** Self-description shown by `engines.catalog()` / the admin UI. */
export interface OKDBEngineDriverDocs {
    summary?: string;
    description?: string;
    /** Can run outside a pipeline. Default `true`. */
    standalone?: boolean;
    /** Can be a pipeline member. Default `false`. */
    pipelineCompatible?: boolean;
    /** Default `'env'`. */
    scope?: 'global' | 'env';
    configSchema?: Record<string, unknown>;
    configExample?: Record<string, unknown>;
    patchConfigSchema?: Record<string, unknown>;
    patchableConfigKeys?: string[];
    notes?: string[];
    links?: string[];
}

/** Context passed to every driver lifecycle hook. */
export interface OKDBEngineDriverContext {
    okdb: OKDB;
    /** `<type>@<name>`. */
    key: string;
    type: string;
    name: string;
    /** The env holding this engine's `~engines` record. */
    storeEnv: OKDBEnvironment;
    storeEnvName: string;
    config: Record<string, unknown>;
    meta: Record<string, unknown>;
    /** Emit `engine:<event>` on `okdb.events` (payload gains `engine`, `type`, `name`). */
    emit(event: string, payload?: Record<string, unknown>): void;
    /** Set this node's runtime status (throws `ENGINE_INVALID_STATUS` otherwise). */
    updateStatus(status: OKDBEngineUpdatableStatus, error?: unknown): Promise<void>;
    /** Merge-patch the persisted `meta` (e.g. checkpoint a resume clock). */
    updateMeta(patch: Record<string, unknown>): Promise<void>;
    /** Merge-patch the persisted `config` (e.g. resolved dims). */
    updateConfig(patch: Record<string, unknown>): Promise<void>;
}

/** Context passed to `driver.assertCreateAllowed()`. */
export interface OKDBEngineCreateContext {
    okdb: OKDB;
    key: string;
    type: string;
    name: string;
    config: Record<string, unknown>;
    meta: Record<string, unknown>;
    storeEnv: OKDBEnvironment;
    storeEnvName: string | null;
    options: OKDBEngineCreateOptions;
}

/** Context passed to `driver.patchConfig()`. */
export interface OKDBEngineConfigPatchContext {
    okdb: OKDB;
    key: string;
    type: string;
    name: string;
    storeEnv: OKDBEnvironment;
    storeEnvName: string | null;
}

/** A driver registered with `engines.registerDriver(type, driver)`. Only `start` is required. */
export interface OKDBEngineDriver<TApi = OKDBEngineApi> {
    docs?: OKDBEngineDriverDocs;
    /** Throw to reject an invalid config (runs on load and after config patches). */
    validate?(config: Record<string, unknown>): void;
    /** Throw to refuse creation. */
    assertCreateAllowed?(ctx: OKDBEngineCreateContext): void | Promise<void>;
    /** Throw to refuse a start (an error with code `ENGINE_LEASE_NOT_ACQUIRED` → stays `inactive`, not `error`). */
    assertStartAllowed?(ctx: OKDBEngineDriverContext): void | Promise<void>;
    /** One-time setup, before the first successful start. */
    install?(ctx: OKDBEngineDriverContext): void | Promise<void>;
    /** Required. Returns the runtime API exposed as `engine.api`. */
    start(ctx: OKDBEngineDriverContext): TApi | Promise<TApi>;
    stop?(ctx: OKDBEngineDriverContext): void | Promise<void>;
    uninstall?(ctx: OKDBEngineDriverContext): void | Promise<void>;
    /** Enables `patchDeclaration({ config })`; returns the full next config. */
    patchConfig?(
        current: Record<string, unknown>,
        patch: Record<string, unknown>,
        ctx: OKDBEngineConfigPatchContext,
    ): Record<string, unknown> | Promise<Record<string, unknown>>;
}

/** One row of `engines.catalog()` — a registered driver type and its docs. */
export interface OKDBEngineCatalogEntry {
    type: string;
    summary: string | null;
    description: string | null;
    standalone: boolean;
    pipelineCompatible: boolean;
    scope: 'global' | 'env';
    configSchema: Record<string, unknown> | null;
    configExample: Record<string, unknown> | null;
    patchConfigSchema: Record<string, unknown> | null;
    patchableConfigKeys: string[];
    /** Engine-kind template ids targeting this type. */
    templateIds: string[];
    recommendedTemplateIds: string[];
    notes: string[];
    links: string[];
}

// ─── Templates ────────────────────────────────────────────────────────────────

/** Plan produced by a template's `build()` — `kind: 'engine'` or `'pipeline'`; rest is template-specific. */
export interface OKDBEngineTemplatePlan {
    kind: 'engine' | 'pipeline';
    [key: string]: unknown;
}

/** A starter template registered with `engines.registerTemplate()`. */
export interface OKDBEngineTemplateDefinition {
    id: string;
    kind: 'engine' | 'pipeline';
    /** Expand user input into a concrete plan. Throw on invalid input. */
    build(input: Record<string, unknown>, context: { okdb: OKDB; envName: string | null }): OKDBEngineTemplatePlan;
    family?: string;
    engineType?: string;
    pipelineFamily?: string;
    recommended?: boolean;
    summary?: string;
    description?: string;
    /** JSON schema of `build()` input, or a function computing it. */
    inputSchema?: Record<string, unknown> | ((okdb: OKDB) => Record<string, unknown>);
    defaults?: Record<string, unknown>;
    notes?: string[];
    links?: string[];
}

/** A template as returned by `listTemplates()` / `getTemplate()`. */
export interface OKDBEngineTemplate {
    id: string;
    kind: 'engine' | 'pipeline';
    family: string | null;
    engineType: string | null;
    pipelineFamily: string | null;
    recommended: boolean;
    summary: string | null;
    description: string | null;
    inputSchema: Record<string, unknown>;
    defaults: Record<string, unknown>;
    notes: string[];
    links: string[];
}

export interface OKDBEngineTemplatePreview {
    template: OKDBEngineTemplate;
    plan: OKDBEngineTemplatePlan;
}

// ─── OKDBEngines ──────────────────────────────────────────────────────────────

/**
 * Engine manager: named, typed, driver-backed persistent services. Declarations
 * live in `~engines` records and are restored/started on `open()` on nodes with
 * the `engines` role; runtime state is node-local.
 *
 * Attached twice, one class:
 * - `db.engines` — the process-wide orchestrator. Sees every engine;
 *   `createEngine()` here stores the declaration in `~system` (a shared/global engine).
 * - `env.engines` — env facade over the same driver/template/instance registry.
 *   `createEngine()` stores in that env; `getEngine()` / `list()` only see engines
 *   stored in that env (`getEngine` returns `null` for others).
 *
 * `registerDriver`/`registerTemplate` always register on the orchestrator.
 * Pipeline members: the HTTP/admin surfaces refuse delete/stop/start/restart of a
 * member with `ENGINE_MANAGED_BY_PIPELINE`; the SDK methods here do not check —
 * operate on the owning pipeline (`db.pipelines.findOwner(type, name)`).
 *
 * Removed: the per-engine `affinity` field (replaced by the engine-level lease; stripped from records on boot).
 */
export declare class OKDBEngines {
    /** True for `db.engines`, false for an `env.engines` facade. */
    readonly isOrchestrator: boolean;

    // ── Drivers & templates ───────────────────────────────────────────────────

    /**
     * Register a driver for an engine type. Call before `open()` so persisted
     * engines of this type can be restored. Throws `ENGINE_DRIVER_ALREADY_REGISTERED`
     * on a duplicate type, `ENGINE_DRIVER_MISSING_START` without `start()`.
     * Built-in types include `processor`, `materializer`, `queue-worker` and the
     * embeddings family (`embedder`, `indexer`, `vector-search`, `embed-worker`).
     */
    registerDriver(type: string, driver: OKDBEngineDriver): void;
    /** Register a starter template. Throws `ENGINE_TEMPLATE_ALREADY_REGISTERED` on a duplicate id. */
    registerTemplate(template: OKDBEngineTemplateDefinition): void;
    /** Registered templates sorted by id, optionally filtered by kind. */
    listTemplates(kind?: 'engine' | 'pipeline' | null): OKDBEngineTemplate[];
    getTemplate(id: string): OKDBEngineTemplate | null;
    /**
     * Expand a template into its plan without persisting anything.
     * Throws `ENGINE_TEMPLATE_NOT_FOUND`.
     */
    previewTemplate(
        id: string,
        input?: Record<string, unknown>,
        context?: { envName?: string | null },
    ): OKDBEngineTemplatePreview;
    /** Every registered driver type with its self-declared docs, sorted by type. */
    catalog(): OKDBEngineCatalogEntry[];

    // ── Engines ───────────────────────────────────────────────────────────────

    /**
     * Persist a new engine declaration and return the (loaded, not started) instance.
     * Throws `ENGINE_UNKNOWN_TYPE`, `ENGINE_ALREADY_EXISTS`, or a license error
     * (`LICENSE_FEATURE_DISABLED` / `LICENSE_LIMIT_EXCEEDED`).
     */
    createEngine<TApi = OKDBEngineApi>(
        type: string,
        name: string,
        config: Record<string, unknown>,
        meta?: Record<string, unknown>,
        options?: OKDBEngineCreateOptions,
    ): Promise<OKDBEngine<TApi>>;
    /** `createEngine()` + `engine.start()`. A failed start leaves the engine in `error` state rather than throwing. */
    createAndStartEngine<TApi = OKDBEngineApi>(
        type: string,
        name: string,
        config: Record<string, unknown>,
        meta?: Record<string, unknown>,
        options?: OKDBEngineCreateOptions,
    ): Promise<OKDBEngine<TApi>>;
    /**
     * Engine by type + name (any runtime state), or `null`. Throws
     * `ENGINE_SYSTEM_NOT_STARTED` if the engine subsystem never started on this
     * node (before `open()`, or an `engines: false` node).
     */
    getEngine<TApi = OKDBEngineApi>(type: string, name: string): OKDBEngine<TApi> | null;
    /** Like `getEngine()` but `null` unless running on this node; never throws `ENGINE_SYSTEM_NOT_STARTED`. */
    getRunningEngine<TApi = OKDBEngineApi>(type: string, name: string): OKDBEngine<TApi> | null;
    /** Known engine instances on this node, optionally filtered by type (env facade: that env's only). */
    list(type?: string | null): OKDBEngine[];
    /** Stop (if running), reload the declaration, start again. Throws `ENGINE_NOT_FOUND`. */
    restart<TApi = OKDBEngineApi>(type: string, name: string): Promise<OKDBEngine<TApi>>;
    /** Stop, run the driver's uninstall hook and delete the declaration. Throws `ENGINE_NOT_FOUND`. */
    uninstallEngine(type: string, name: string): Promise<void>;
}
