import type { OKDBIndexKey } from '../options';
import type { EventEmitter } from 'events';

export type OKDBJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface OKDBJobBucket {
    id: string;
    tokens: number;
}

export interface OKDBJob {
    id: string;
    type: string;
    idempotency_key: string | null;
    status: OKDBJobStatus;
    status_code: string | null;
    status_message: string | null;
    error_stack: string | null;
    progress: string | null;
    when: number;
    priority: number;
    tags: string[];
    tag: string | null;
    bucket: string | null;
    bucket_tokens: number | null;
    buckets: OKDBJobBucket[] | null;
    cron: string | null;
    created: number;
    updated: number;
    finished: number | null;
    tries: number;
    max_tries: number | null;
    retry_delay: number;
    backoff_multiplier: number;
    claim_id: string | null;
    claim_expires: number | null;
    done_ttl: number | null;
    failed_ttl: number | null;
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
    backoff_multiplier: number;
    priority: number;
    ttl: number | null;
    done_ttl: number | null;
    failed_ttl: number | null;
    buckets: OKDBJobBucket[] | null;
}

export interface OKDBEnqueueOptions {
    when?: number;
    priority?: number;
    tags?: string[];
    bucket?: string;
    bucket_tokens?: number;
    buckets?: OKDBJobBucket[];
    cron?: string;
    max_tries?: number | null;
    retry_delay?: number;
    backoff_multiplier?: number;
    done_ttl?: number | null;
    failed_ttl?: number | null;
    idempotency_key?: string | number;
    txn?: OKDBQueueTransaction;
}

export interface OKDBClaimOptions {
    ttl?: number;
    tags?: string[];
    bucket?: string;
}

export interface OKDBListJobsOptions {
    type?: string | null;
    status?: OKDBJobStatus | null;
    bucket?: string | null;
    tag?: string | null;
    sort?: 'when' | 'priority';
    direction?: 'asc' | 'desc';
    limit?: number;
    cursor?: OKDBIndexKey | null;
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
    commit(): Promise<void>;
}

export interface OKDBQueueWorker {
    stop(timeout?: number): Promise<void>;
}

export interface OKDBQueueSpawnedWorker {
    stop(timeout?: number): Promise<void>;
}

export declare class OKDBQueue {
    events: EventEmitter;

    // ── Core job lifecycle ────────────────────────────────────────────────────
    enqueue(type: string, payload: unknown, options?: OKDBEnqueueOptions): Promise<string>;
    claim(type: string, options?: OKDBClaimOptions): Promise<OKDBJob | null>;
    worker(
        type: string,
        handler: (job: OKDBJob) => Promise<unknown> | unknown,
        options?: Record<string, unknown>,
    ): OKDBQueueWorker;
    spawn(type: string, modulePath: string, options?: Record<string, unknown>): Promise<OKDBQueueSpawnedWorker>;
    stopAll(timeout?: number): Promise<void>;

    // ── Job retrieval / management ────────────────────────────────────────────
    getJob(id: string): Promise<OKDBJob | null>;
    updateJob(
        id: string,
        patch: Partial<OKDBJob & { payload: unknown }>,
        options?: { txn?: OKDBQueueTransaction },
    ): Promise<OKDBJob>;
    removeJob(id: string, options?: { txn?: OKDBQueueTransaction }): Promise<boolean>;
    retryJob(id: string): Promise<OKDBJob>;
    cancelJob(id: string): Promise<OKDBJob>;
    list(options?: OKDBListJobsOptions): Promise<{ items: OKDBJob[]; cursor: OKDBIndexKey | null }>;

    // ── Worker callbacks ──────────────────────────────────────────────────────
    heartbeat(jobId: string, claimId: string, ttl?: number | null): Promise<OKDBJob>;
    markJobHeartbeat(jobId: string, claimId: string, ttl?: number | null): Promise<OKDBJob>;
    markJobProgress(jobId: string, claimId: string, message: string): Promise<OKDBJob>;
    markJobComplete(jobId: string, claimId: string, result?: unknown): Promise<OKDBJob>;
    completeJob(jobId: string, claimId: string, result?: unknown): Promise<OKDBJob>;
    markJobFail(
        jobId: string,
        claimId: string,
        err: Error | unknown,
        code?: string,
    ): Promise<{ permanentlyFailed: boolean; job: OKDBJob }>;
    failJob(
        jobId: string,
        claimId: string,
        err: Error | unknown,
        code?: string,
    ): Promise<{ permanentlyFailed: boolean; job: OKDBJob }>;
    releaseClaim(
        jobId: string,
        claimId: string,
        options?: { when?: number; statusCode?: string; keepTry?: boolean },
    ): Promise<boolean>;

    // ── Bulk operations ───────────────────────────────────────────────────────
    clearDone(type?: string | null, limit?: number): Promise<number>;
    clearFailed(type?: string | null, limit?: number): Promise<number>;
    clearStuck(type?: string | null, limit?: number): Promise<number>;
    retryFailed(type?: string | null, limit?: number): Promise<number>;

    // ── Token buckets ─────────────────────────────────────────────────────────
    addBucket(id: string, options?: OKDBAddBucketOptions): Promise<void>;
    updateBucket(id: string, patch: Partial<OKDBJobBucketRecord>): Promise<void>;
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
    drainJobType(id: string): Promise<OKDBJobType>;
    setJobTypeSchema(id: string, definition: unknown, enforce?: boolean): Promise<OKDBJobType>;
    removeJobTypeSchema(id: string): Promise<OKDBJobType>;
    samplePayloads(type: string, limit?: number): Promise<unknown[]>;
}
