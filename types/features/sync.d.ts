/**
 * A node record as stored in the replicated `~sync_nodes` type (in `~system`).
 * `getSelfNode()` returns this node's record; peers carry the same shape.
 */
export interface OKDBSyncNode {
    id: string;
    address: string | null;
    meta: Record<string, unknown>;
    /** Normalized node tags (used for engine affinity). */
    tags: string[];
    updated: number | null;
    /** Ed25519 public key peers use to verify this node's signed sync requests. */
    publicKey?: string | null;
    created?: number;
    joined?: number;
    [key: string]: unknown;
}

/** Returned by `db.sync.info()`. */
export interface OKDBSyncInfo {
    node_id: string;
    /** Local clock (0 before open). */
    clock: number;
    auto_reconcile: boolean;
    /** Number of known peers (self excluded). */
    peers: number;
    /** Peer ids with a data-plane reconcile currently in flight. */
    reconciling: string[];
}

/** Link direction, canonical relative to the sorted (node_lo, node_hi) pair. */
export type OKDBSyncLinkDirection = 'both' | 'lo_to_hi' | 'hi_to_lo';

/** A data-link record (replicated `~sync_links` type). */
export interface OKDBSyncLink {
    /** Canonical id `"<lo>:<hi>"` — (A,B) and (B,A) map to the same link. */
    id: string;
    node_lo: string;
    node_hi: string;
    direction: OKDBSyncLinkDirection;
    /** Env names the link replicates; null = all user envs. */
    envs: string[] | null;
    enabled: boolean;
    created: number;
    updated: number;
}

export interface OKDBSyncLinkOptions {
    /** Default 'both'. */
    direction?: OKDBSyncLinkDirection;
    /** Env names to replicate; null (default) = all user envs. */
    envs?: string[] | null;
    /** Default true. */
    enabled?: boolean;
}

/** One entry of `db.sync.peers()` — the peer's node record merged with local (non-replicated) progress. */
export interface OKDBSyncPeer {
    peer_id: string;
    address: string | null;
    meta: Record<string, unknown>;
    tags: string[];
    node_updated: number | null;
    link: { direction: OKDBSyncLinkDirection; envs: string[] | null; enabled: boolean } | null;
    status: 'idle' | 'reconciling' | 'error' | (string & {});
    /** Last pulled `default`-env clock. */
    clock: number;
    /** Last pulled clock per env. */
    clocks?: Record<string, number>;
    last_seen: number | null;
    last_error: string | null;
    last_error_at?: number;
    created?: number;
    updated?: number;
}

export interface OKDBSyncJoinOptions {
    /** Bearer token accepted by the remote node (one-time handshake credential). */
    token?: string;
    /** Username for the remote's /auth/login (exchanged for a token). */
    username?: string;
    password?: string;
    /** Patch applied to this node's own record before joining (see `patchSelf`). */
    my_info?: Record<string, unknown>;
    /** Create a bidirectional data link to the remote. Default true. */
    dataLink?: boolean;
}

/** A change record inside a sync delta. */
export interface OKDBSyncChange {
    type: string;
    key: unknown;
    action: string;
    clock: number;
    timestamp: number;
    origin?: string;
    /** Present for puts. */
    value?: unknown;
    version?: number;
    /** Env the change belongs to. */
    _env: string;
    [key: string]: unknown;
}

/** Returned by `db.sync.calculateDelta()`. */
export interface OKDBSyncDelta {
    /** The `default` env's clock (0 when not included). */
    clock: number;
    /** Current clock per included env. */
    clocks: Record<string, number>;
    changes: OKDBSyncChange[];
    /**
     * With `peer`: requested envs the link does not let this node send to that peer — omitted
     * from `changes`/`clocks`. (The HTTP response only carries it when non-empty.)
     */
    denied: string[];
}

export interface OKDBSyncPeerAck {
    peer_id: string;
    /** Highest clock the peer has acknowledged, per env. */
    envs: Record<string, number>;
    last_seen: number | null;
    since_ms: number;
    stale: boolean;
}

export interface OKDBSyncGcResult {
    removed: number;
    durationMs: number;
    /** Entries removed per env. */
    byEnv: Record<string, number>;
    /** Set when the sweep was skipped (passive instance, or another process is sweeping). */
    skipped?: 'passive' | 'peer-sweeping';
}

export interface OKDBSyncGcStatus {
    peers: OKDBSyncPeerAck[];
    envs: Array<{ env: string; currentClock: number; gcHorizon: number; entryCount: number }>;
    running: boolean;
    peerStalenessLimitMs: number;
}

/** Watermark-based changelog GC (`db.sync.gc`). Sweeps automatically on processor-role instances. */
export declare class OKDBSyncGC {
    /** Changelog entries strictly below this clock are safe to prune for the env; 0 = don't prune. */
    getGcHorizon(envName: string): number;
    getPeerAcks(): OKDBSyncPeerAck[];
    /** Run a sweep now (1-of-N across processes; skipped on a passive instance). */
    runGc(): Promise<OKDBSyncGcResult>;
    /** Reset a peer's ACK watermarks to 0 so the log is retained for a full resync. */
    forceResync(peer_id: string): Promise<void>;
    getStatus(): OKDBSyncGcStatus;
}

/**
 * Peer-to-peer LWW replication (`db.sync`). Always attached; configured by the
 * `sync` constructor option (`address`, `token`, `delta_limit`, `auto_reconcile`, …).
 * Removed: per-env `createEnvironment(name, { sync: false })` throws `SYNC_OPTION_REMOVED`
 * (every user env replicates; internal `~` envs never do).
 */
export declare class OKDBSync {
    /** Changelog GC controller. */
    readonly gc: OKDBSyncGC;

    info(): OKDBSyncInfo;
    /** This node's `~sync_nodes` record (a synthetic one before open). */
    getSelfNode(): OKDBSyncNode;
    /** Known peers (self excluded) with local reconcile progress. */
    peers(): OKDBSyncPeer[];
    /**
     * Join a remote node: exchange node records/public keys, optionally create a data link,
     * then pull an initial delta. Requires the `sync.address` option (else `SYNC_NO_ADDRESS`).
     */
    join(address: string, options?: OKDBSyncJoinOptions): Promise<void>;
    /** Merge a patch into this node's own record (e.g. `{ tags, meta }`); returns the new record. */
    patchSelf(patch: Record<string, unknown>): Promise<OKDBSyncNode>;
    /** Reconcile with all peers now. No-op without a sync address. */
    reconcile(): Promise<void>;
    /** Reconcile with one peer now. No-op without a sync address. */
    reconcilePeer(peer_id: string): Promise<void>;
    listLinks(): OKDBSyncLink[];
    /** Create or update the data link between this node and `peer_id`. */
    upsertLink(peer_id: string, options?: OKDBSyncLinkOptions): Promise<OKDBSyncLink>;
    removeLink(peer_id: string): Promise<void>;
    /**
     * Low-level: compute the outbound delta after `from_clocks` (per env). `envs: null` = all
     * changelog-enabled envs. This is what the `/api/sync/delta` endpoint serves. `peer` (the
     * endpoint passes the signed requester's node id) enforces that peer's link scope: only
     * `~system` plus the data envs the link lets this node send it (all envs while no link exists
     * anywhere — legacy full mesh).
     */
    calculateDelta(
        from_clocks?: Record<string, number>,
        options?: { limit?: number; envs?: string[] | null; peer?: string | null },
    ): Promise<OKDBSyncDelta>;
}
