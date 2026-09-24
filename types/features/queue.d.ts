import type { OKDBIndexEntry } from '../options';
import type { EventEmitter } from 'events';
import type { OKDB } from '../okdb';

export type OKDBJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface OKDBJobBucket {
    id: string;
    tokens: number;
}

export interface OKDBJob {
    id: string;
    type: string;
    idempotency_key: string | null;
    /** Present only when enqueued with `idempotency_scope: 'pending'`. */
    idempotency_scope?: 'pending';
    status: OKDBJobStatus;
    /** e.g. `'cancelled'` (cancelJob), `'manual_retry'` (retryJob), `'shutdown'` / `'paused'` (released claim), or the fail code. */
    status_code: string | null;
    status_message: string | null;
    error_stack: string | null;
    progress?: string | null;
    /** Handler / markJobComplete result, stored when JSON-serializable and ≤ 16 KB; else null. */
    result?: unknown;
    when: number;
    priority: number;
    tags: string[];
    tag: string | null;
    /** Legacy single-bucket fields (null on new jobs). */
    bucket: string | null;
    bucket_tokens: number | null;
    buckets: OKDBJobBucket[] | null;
    cron: string | null;
    created: number;
    updated: number;
    finished: number | null;
    tries: number;
    /** null = unlimited. */
    max_tries: number | null;
    retry_delay: number;
    backoff_multiplier: number;
    claim_id: string | null;
    claim_expires: number | null;
    /** Pid / hostname of the claiming process (set at claim). */
    claim_pid?: number;
    claim_host?: string;
    /** Per-job log ring-buffer cap. */
    logCap?: number;
    done_ttl: number | null;
    failed_ttl: number | null;
    /**
     * Cron jobs only: how the previous occurrence ended. Every terminal path of a cron run
     * (done, permanently failed, claim timeout) re-queues the same row as `pending` at the next
     * cron time with `tries: 0`, recording the finished run here. Cancel stops the series.
     */
    last_run?: {
        status: 'done' | 'failed';
        status_code: string | null;
        status_message: string | null;
        tries: number;
        finished: number;
    };
    /** Included by getJob / claim / updateJob; not on `list()` items. */
    payload?: unknown;
}

export interface OKDBJobBucketRecord {
    id: string;
    tokens: number;
    capacity: number;
    refill_amount: number;
    refill_every: number;
    updated: number;
}

export type OKDBJobTypeStatus = 'active' | 'paused' | 'draining';

export interface OKDBJobType {
    id: string;
    status: OKDBJobTypeStatus;
    max_concurrency: number | null;
    defaults: Partial<OKDBJobDefaults>;
    payload_schema: { definition: unknown; enforce: boolean } | null;
    created_at: number;
    updated_at: number;
}

export interface OKDBJobDefaults {
    max_tries: number | null;
    retry_delay: number;
    backoff_multiplier: number | null;
    priority: number;
    /** Default claim TTL (ms) for this type. */
    ttl: number | null;
    done_ttl: number | null;
    failed_ttl: number | null;
    buckets: OKDBJobBucket[] | null;
    logCap: number | null;
}

export interface OKDBEnqueueOptions {
    when?: number;
    priority?: number;
    tags?: string[] | string;
    /** Legacy single bucket; prefer `buckets`. */
    bucket?: string;
    bucket_tokens?: number;
    buckets?: OKDBJobBucket[];
    cron?: string;
    max_tries?: number | null;
    retry_delay?: number;
    backoff_multiplier?: number;
    done_ttl?: number | null;
    failed_ttl?: number | null;
    /**
     * Dedups against a LIVE (pending / running) job with the same key and returns that job's id.
     * Every terminal state (done, failed, cancelled, timed out) releases the key, so a later
     * enqueue with it creates a new job. A cron job keeps its key across occurrences.
     */
    idempotency_key?: string | number;
    /** `'active'` (default): dedup against pending or running. `'pending'`: pending only (key released at claim). */
    idempotency_scope?: 'active' | 'pending';
    /** Per-job log ring-buffer cap (1–50 000; default 500). */
    logCap?: number;
    txn?: OKDBQueueTransaction;
}

export interface OKDBClaimOptions {
    /** Claim TTL in ms (default: job-type `defaults.ttl` ?? queue `default_ttl`, 30 000). */
    ttl?: number;
    tags?: string[] | string;
    bucket?: string;
}

export interface OKDBListJobsOptions {
    type?: string | null;
    status?: OKDBJobStatus | null;
    bucket?: string | null;
    tag?: string | null;
    sort?: 'when' | 'priority';
    direction?: 'asc' | 'desc';
    /** 1–1000, default 50. */
    limit?: number;
    /**
     * Opaque string from the previous page's `cursor` (exclusive: the next page starts after
     * that row). Bound to the type/status/sort it was issued for — reusing it with a different
     * filter, or passing an old index-key array cursor, throws BAD_PARAM.
     */
    cursor?: string | null;
}

/** Fields accepted by `updateJob`. `payload: undefined` removes the payload. */
export interface OKDBUpdateJobPatch {
    type?: string;
    when?: number;
    priority?: number;
    tags?: string[] | string;
    bucket?: string | null;
    bucket_tokens?: number;
    buckets?: OKDBJobBucket[] | null;
    cron?: string | null;
    max_tries?: number | null;
    retry_delay?: number;
    backoff_multiplier?: number;
    status_message?: string | null;
    progress?: string | null;
    payload?: unknown;
}

export interface OKDBAddBucketOptions {
    capacity?: number;
    tokens?: number;
    refill_amount?: number;
    refill_every?: number;
    txn?: OKDBQueueTransaction;
}

export interface OKDBAddJobTypeOptions {
    status?: OKDBJobTypeStatus;
    max_concurrency?: number | null;
    defaults?: Partial<OKDBJobDefaults>;
}

export interface OKDBQueueTransaction {
    put(type: string, key: string | number, value: unknown): void;
    remove(type: string, key: string | number): void;
    update(type: string, key: string | number, value: unknown, opts?: unknown): void;
    commit(): Promise<unknown>;
}

export type OKDBJobLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Input to `appendJobLog` / `ctx.log`: a message string or an entry object. */
export type OKDBJobLogInput =
    string | { message: string; level?: OKDBJobLogLevel; fields?: Record<string, unknown> | null };

export interface OKDBJobLogEntry {
    level: OKDBJobLogLevel;
    message: string;
    fields: Record<string, unknown> | null;
    ts: number;
}

/** Context passed to a `process()` handler. None of its methods reject. */
export interface OKDBQueueHandlerContext {
    /** The root OKDB instance. */
    okdb: OKDB;
    /** The claimed job record (includes `payload`). */
    job: OKDBJob;
    jobId: string;
    /**
     * Cooperative cancellation. Aborted when the job is cancelled (`reason.code`
     * `'JOB_CANCELLED'`), its claim is lost — removed, reclaimed after expiry, completed
     * elsewhere (`'CLAIM_LOST'`; same-process changes abort at once, others at the next
     * heartbeat) — or `stop(timeout)` runs out of time (`'WORKER_STOPPING'`). `reason` is an
     * OKDBError. okdb never kills a handler: check the signal / pass it to fetch & co. and return
     * or throw promptly. After a JOB_CANCELLED / CLAIM_LOST abort the outcome is ignored.
     */
    signal: AbortSignal;
    /** Extend the claim by the TTL the job was claimed with; a lost claim aborts `signal`. */
    heartbeat(): Promise<OKDBJob | void>;
    /** Set the job's `progress` field. */
    markProgress(message: string): Promise<OKDBJob | void>;
    /** Append a log line to the current attempt. */
    log(messageOrEntry: OKDBJobLogInput, level?: OKDBJobLogLevel): Promise<{ attempt: number; seq: number } | void>;
}

/** Return value is stored as the job's `result` (JSON-serializable, ≤ 16 KB); a throw fails the attempt. */
export type OKDBQueueHandler<TPayload = unknown> = (payload: TPayload, ctx: OKDBQueueHandlerContext) => unknown;

/** Per-type knobs, shared by the single form's options and each pool lane. */
export interface OKDBQueueLaneOptions extends OKDBClaimOptions {
    /** Keep the claim alive while the handler runs (default true; every ttl/3, min 1 s). */
    autoHeartbeat?: boolean;
    /** Called once a job fails with no retries left. */
    onPermanentFail?: (job: OKDBJob, err: unknown) => unknown;
}

/** Pool knobs shared by every lane of one consumer. */
export interface OKDBQueuePoolOptions {
    /** Parallel lanes across ALL entries (default 1) — the process-wide cap for this pool. */
    concurrency?: number;
    /** Caps the idle backstop in ms (wake is event-driven) and spreads lane start-up (default 1000). */
    pollInterval?: number;
    /** Consulted before every claim sweep; false (or a throw) = don't claim. E.g. `() => db.pressure().score < 1`. */
    admission?: () => boolean | Promise<boolean>;
    /** ms between admission rechecks while gated (default 500). */
    admissionInterval?: number;
}

/** Options of the single form `process(type, handler, options)` — lane and pool knobs in one object. */
export interface OKDBQueueProcessOptions extends OKDBQueueLaneOptions, OKDBQueuePoolOptions {}

/** One entry of the pool form `process([entry, …], poolOptions)`. */
export interface OKDBQueuePoolLane<TPayload = unknown> extends OKDBQueueLaneOptions {
    type: string;
    handler: OKDBQueueHandler<TPayload>;
    /** Claim-sweep bias (int 1–32, default 1): weight 3 gets ~3× the first-claim attempts of weight 1. */
    weight?: number;
}

/** Handle returned by `process()`. */
export interface OKDBQueueConsumer {
    /** The type, or comma-joined types for a pool. */
    readonly type: string;
    readonly running: boolean;
    /**
     * Stop claiming and wait up to `timeout` ms (default 30 000) for in-flight handlers. Handlers
     * still running then have `ctx.signal` aborted (`'WORKER_STOPPING'`) but KEEP their claim —
     * never handed to another consumer while running. When one settles its job is completed
     * (resolved) or released to pending without burning a try (threw). If the process exits
     * first, reconcile reclaims the job (at-least-once).
     */
    stop(timeout?: number): Promise<void>;
    /** `stop(0)`. */
    kill(): Promise<void>;
}

/** Event names emitted on the root `okdb.events`. */
export type OKDBQueueEventName =
    | 'queue:enqueued'
    | 'queue:done'
    | 'queue:failed'
    | 'queue:retry'
    /** A cron run ended (done / failed / timeout) and the job is pending for its next occurrence. */
    | 'queue:rescheduled'
    | 'queue:removed'
    | 'queue:reconciled'
    | 'queue:clear-progress'
    | 'queue:clear-done'
    | 'queue:log';

/**
 * Durable job queue (per env). okdb coordinates — CAS claim = exactly one consumer,
 * at-least-once — and handlers run wherever `process()` is called.
 *
 * Removed: worker(), spawn() — throw QUEUE_WORKER_REMOVED; use process()
 */
export declare class OKDBQueue {
    /** Unused: queue events (`OKDBQueueEventName`) are emitted on the root `okdb.events`. */
    events: EventEmitter;

    // ── Core job lifecycle ────────────────────────────────────────────────────
    /** Resolves to the new job id (or the existing id on an idempotency hit). */
    enqueue(type: string, payload: unknown, options?: OKDBEnqueueOptions): Promise<string>;
    claim(type: string, options?: OKDBClaimOptions): Promise<OKDBJob | null>;

    /** In-loop consumer for one type. */
    process<TPayload = unknown>(
        type: string,
        handler: OKDBQueueHandler<TPayload>,
        options?: OKDBQueueProcessOptions,
    ): OKDBQueueConsumer;
    /** One lane pool over several types (shared concurrency cap, weighted fairness, admission gate). */
    process(entries: OKDBQueuePoolLane<any>[], poolOptions?: OKDBQueuePoolOptions): OKDBQueueConsumer;

    /** Stop every consumer started by `process()` on this queue. */
    stopAll(timeout?: number): Promise<void>;

    // ── Job retrieval / management ────────────────────────────────────────────
    getJob(id: string): Promise<OKDBJob | null>;
    updateJob(id: string, patch: OKDBUpdateJobPatch, options?: { txn?: OKDBQueueTransaction }): Promise<OKDBJob>;
    removeJob(id: string, options?: { txn?: OKDBQueueTransaction }): Promise<boolean>;
    /** Reset to pending with `tries: 0`, clearing result and logs. */
    retryJob(id: string): Promise<OKDBJob>;
    /**
     * Pending/running → failed with `status_code: 'cancelled'`; otherwise throws BAD_STATE.
     * Releases the idempotency key, stops a cron series, and aborts a running handler's `ctx.signal`.
     */
    cancelJob(id: string): Promise<OKDBJob>;
    /** Items are index entries (`value` is the job, without payload). `cursor` is null on the last page. */
    list(options?: OKDBListJobsOptions): Promise<{ items: OKDBIndexEntry<OKDBJob>[]; cursor: string | null }>;

    // ── Worker callbacks (manual claim flow) ─────────────────────────────────
    /** Extends the claim. A lost claim rejects: NOT_FOUND (removed), INVALID_STATE (not running), CLAIM_MISMATCH (re-claimed). */
    markJobHeartbeat(jobId: string, claimId: string, ttl?: number | null): Promise<OKDBJob | null>;
    /** Alias of markJobHeartbeat. */
    heartbeat(jobId: string, claimId: string, ttl?: number | null): Promise<OKDBJob | null>;
    markJobProgress(jobId: string, claimId: string, message: string): Promise<OKDBJob | null>;
    markJobComplete(jobId: string, claimId: string, result?: unknown): Promise<OKDBJob | null>;
    /** Alias of markJobComplete. */
    completeJob(jobId: string, claimId: string, result?: unknown): Promise<OKDBJob | null>;
    markJobFail(
        jobId: string,
        claimId: string,
        err: unknown,
        code?: string,
    ): Promise<{ permanentlyFailed: boolean; job: OKDBJob | null }>;
    /** Alias of markJobFail. */
    failJob(
        jobId: string,
        claimId: string,
        err: unknown,
        code?: string,
    ): Promise<{ permanentlyFailed: boolean; job: OKDBJob | null }>;
    /** Running → pending. Returns false if the job isn't running under this claim. */
    releaseClaim(
        jobId: string,
        claimId: string,
        options?: { when?: number; statusCode?: string; keepTry?: boolean },
    ): Promise<boolean>;

    // ── Job logs ──────────────────────────────────────────────────────────────
    /** Append to a running job's current attempt; `claimId: null` skips the claim check. */
    appendJobLog(
        jobId: string,
        claimId: string | null,
        entry: OKDBJobLogInput,
    ): Promise<{ attempt: number; seq: number }>;
    /** Chronological, paginated; `cursor` is the opaque string from the previous page. */
    getJobLogs(
        jobId: string,
        options?: { attempt?: number; limit?: number; cursor?: string | null },
    ): Promise<{ items: Array<{ key: [string, number, number]; value: OKDBJobLogEntry }>; cursor: string | null }>;

    // ── Bulk operations (resolve to the count affected) ──────────────────────
    clearDone(type?: string | null, limit?: number): Promise<number>;
    clearFailed(type?: string | null, limit?: number): Promise<number>;
    /** Deletes running jobs whose claim has expired. */
    clearStuck(type?: string | null, limit?: number): Promise<number>;
    retryFailed(type?: string | null, limit?: number): Promise<number>;

    // ── Token buckets ─────────────────────────────────────────────────────────
    addBucket(id: string, options?: OKDBAddBucketOptions): Promise<void>;
    updateBucket(
        id: string,
        patch: Partial<Pick<OKDBJobBucketRecord, 'capacity' | 'tokens' | 'refill_amount' | 'refill_every'>>,
    ): Promise<void>;
    removeBucket(id: string): Promise<void>;
    getBucket(id: string): OKDBJobBucketRecord | null;
    tryClaimTokens(bucketId: string, tokens?: number): Promise<boolean>;

    // ── Job types ─────────────────────────────────────────────────────────────
    addJobType(id: string, options?: OKDBAddJobTypeOptions): Promise<OKDBJobType>;
    getJobType(id: string): Promise<OKDBJobType | null>;
    listJobTypes(): Promise<OKDBJobType[]>;
    removeJobType(id: string): Promise<boolean>;
    pauseJobType(id: string): Promise<OKDBJobType>;
    resumeJobType(id: string): Promise<OKDBJobType>;
    /** Draining: enqueue throws TYPE_DRAINING; existing jobs still run. */
    drainJobType(id: string): Promise<OKDBJobType>;
    setJobTypeSchema(id: string, definition: unknown, enforce?: boolean): Promise<OKDBJobType>;
    removeJobTypeSchema(id: string): Promise<OKDBJobType>;
    /** Up to `limit` (≤ 100) recent payloads of a type. */
    samplePayloads(type: string, limit?: number): Promise<unknown[]>;
}
