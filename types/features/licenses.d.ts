/** Feature flags a license (or the free tier) enables. */
export interface OKDBLicenseFeatures {
    sync?: boolean;
    embeddings?: boolean;
    engines?: boolean;
    fts?: boolean;
    timeMachine?: boolean;
    views?: boolean;
    mcp?: boolean;
    files?: boolean;
    [feature: string]: boolean | undefined;
}

/** Limits a license (or the free tier) sets. Unset / 0 / null = unlimited. */
export interface OKDBLicenseLimits {
    envs?: number | null;
    typesPerEnv?: number | null;
    syncPeers?: number | null;
    maxWrites?: number | null;
    /** Free-tier only — the license format has no such field. */
    pipelinesPerEnv?: number | null;
    [limit: string]: number | null | undefined;
}

/** A stored license, summarized. Never carries the raw blob or activation token. */
export interface OKDBLicenseSummary {
    id: string;
    /** standard = node-bound (PIN → activation token); open = ≤6 months, not node-bound;
     *  internal = vendor, no expiry, not node-bound. */
    type: 'standard' | 'open' | 'internal';
    licensee: string | null;
    /** Status on THIS node. `pending` = stored, awaiting its activation token. */
    status: 'active' | 'pending' | 'expired' | 'wrong_node' | 'invalid';
    /** True for the license currently in effect (the first active one). */
    effective: boolean;
    /** Standard license awaiting (re-)activation on this node — send `pin` to the vendor. */
    needsActivation: boolean;
    /** This node's PIN for a standard license (safe to share); null for open/internal. */
    pin: string | null;
    addedAt: number | null;
    /** Epoch ms; null for internal licenses (no expiry). */
    expiresAt: number | null;
    features: OKDBLicenseFeatures;
    limits: OKDBLicenseLimits;
}

/** Result of a mutation: the summary plus whether anything was written (false = no-op). */
export interface OKDBLicenseChange extends OKDBLicenseSummary {
    changed: boolean;
}

export interface OKDBEffectiveLicense {
    /** True when no license is active and the free tier applies. */
    free: boolean;
    id: string | null;
    type: 'free' | 'standard' | 'open' | 'internal';
    licensee: string | null;
    expiresAt: number | null;
    features: OKDBLicenseFeatures;
    limits: OKDBLicenseLimits;
    /** False on dev builds: features/limits are reported but never enforced. */
    enforced: boolean;
}

/**
 * `db.licenses` — install and inspect licenses from code. Available after `open()`
 * (throws INVALID_STATE before). Mutations take effect immediately in this process.
 * At open(), `OKDB_LICENSE_FILE` (a file holding a blob, a token, or both) is installed
 * through the same idempotent path.
 */
export interface OKDBLicenses {
    /** Install a license blob, an activation token (auto-detected), both whitespace-separated
     *  (`"<blob>\n<token>"`), or `{ blob, activation }`.
     *  Idempotent (re-adding a stored license → `changed:false`). Throws LICENSE_INVALID for a
     *  malformed / unsigned license, LICENSE_ACTIVATION_INVALID for a token that does not
     *  verify on this node, INVALID_INPUT for a wrong argument shape. */
    add(input: string | { blob?: string; activation?: string }): Promise<OKDBLicenseChange>;
    /** Apply an activation token to the stored license it names. Idempotent. */
    activate(token: string): Promise<OKDBLicenseChange>;
    /** Remove a stored license; resolves false when no such id. */
    remove(id: string): Promise<boolean>;
    list(): OKDBLicenseSummary[];
    get(id: string): OKDBLicenseSummary | null;
    /** What is in effect now — the active license or the free tier. */
    effective(): OKDBEffectiveLicense;
}
