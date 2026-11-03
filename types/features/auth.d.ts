/**
 * A stored API token: a record of the `~tokens` type in the `~system` env (key = token id).
 * Tokens are created/listed/revoked via `okdb token create`, the admin UI, or
 * `POST|GET|DELETE /api/auth/tokens` — there is no JS method for it on `db.auth`.
 * The raw bearer value is only returned once, at creation; only its SHA-256 is stored.
 */
export interface OKDBToken {
    /** SHA-256 hex of the raw bearer value. */
    tokenHash: string;
    /** Optional login username (case-insensitive). */
    name: string | null;
    /** scrypt `saltHex:hashHex`, present when the token has a login password. */
    passwordHash: string | null;
    label: string | null;
    /** Base permissions, `"<namespace>:<operation>"` (`"*"` = everything). */
    permissions: string[];
    /** Per-env additive permissions: `{ [envName]: ["<ns>:<op>", ...] }`. */
    grants: Record<string, string[]>;
    createdAt: number;
    lastUsedAt: number | null;
    expiresAt: number | null;
}

export interface OKDBAuthUser {
    id: string | null;
    username: string | null;
    /** For token-backed identities these are the token's permissions. */
    roles: string[];
    isAuthenticated: boolean;
    isSystem: boolean;
}

/** Result of `authenticateRequest()`; also found on HTTP handlers as `context.auth`. */
export interface OKDBAuthContext {
    type: 'system' | 'token' | 'user' | 'anonymous' | 'bootstrap-blocked';
    isAuthenticated: boolean;
    isSystem: boolean;
    user: OKDBAuthUser | null;
    id?: string | null;
    username?: string | null;
    roles?: string[];
    subject?: string | null;
    /** On `system` identities: true when granted by open mode. */
    open?: boolean;
    /** Set on `bootstrap-blocked` (secure mode, no tokens yet, non-loopback client). */
    bootstrapBlocked?: boolean;
    /** Verified claims for HMAC session tokens and OIDC access tokens. */
    claims?: Record<string, unknown>;
    /** Effective permission set used by the permission checks. */
    token?: { permissions: string[]; grants: Record<string, string[]> };
}

/** Result of `login()` / `loginSelect()`. Invalid credentials resolve (never reject) with `ok: false`. */
export type OKDBLoginResult =
    | { ok: false; code?: 'INVALID_CREDENTIALS'; error: string }
    | {
          ok: true;
          /** Several tokens share this name + password: finish with `loginSelect(..., tokenId)`. */
          ambiguous: true;
          candidates: Array<{ tokenId: string; label: string | null; permissions: string[]; createdAt: number }>;
      }
    | {
          ok: true;
          ambiguous?: undefined;
          user: { name: string; permissions: string[] };
          /** Sealed session value; usable as the session cookie or as a Bearer token. */
          cookie: string;
          cookieName: string;
          /** Seconds (from `auth.token.ttl`). */
          expiresIn: number;
      };

/** Claims carried by an HMAC session token (`issueToken()` / `authenticateToken()`). */
export interface OKDBSessionClaims {
    iat: number;
    exp: number;
    sub: string | null;
    username: string | null;
    roles: string[];
    [key: string]: unknown;
}

export interface OKDBSecurityNotice {
    level: 'warn' | 'error';
    code: string;
    title: string;
    message: string;
    hint?: string;
}

export interface OKDBLoginConfig {
    mode: 'open' | 'secure';
    openAccess: boolean;
    bootstrap: boolean;
    setupRequired: false;
    login: { enabled: boolean };
    oauth: { enabled: boolean; providers: string[] };
}

/**
 * Request authentication for the HTTP layer, attached as `db.auth`. Configured by the `auth`
 * constructor option; ready after `open()`. Token management is HTTP/CLI-only (see `OKDBToken`).
 *
 * Removed: `createToken`, `revokeToken`, `listTokens`, `getToken` (never on `db.auth` in 2.x; use
 * `/api/auth/tokens` or `okdb token ...`).
 */
export declare class OKDBAuth {
    /** `'open'` when `auth.open` trusts some client IPs, otherwise `'secure'`. */
    readonly mode: 'open' | 'secure';

    /**
     * Resolve the identity of an HTTP request: bootstrap window → open-mode IP → Bearer token
     * (stored token, HMAC session token, sealed login session, OIDC access token) → session cookie
     * → anonymous. Reads `req.socket.remoteAddress`, `req.headers.authorization`, `req.cookies`,
     * `req.context.internal`.
     */
    authenticateRequest(req: {
        socket?: { remoteAddress?: string | null };
        remoteAddress?: string | null;
        headers?: Record<string, string | string[] | undefined>;
        cookies?: Record<string, string>;
        context?: Record<string, unknown>;
    }): Promise<OKDBAuthContext>;

    /** Password login against `~tokens` records by `name`. */
    login(username: string, password: string): Promise<OKDBLoginResult>;
    /** Completes an ambiguous `login()` by choosing one candidate token. */
    loginSelect(username: string, password: string, tokenId: string): Promise<OKDBLoginResult>;

    /** Sign an HMAC session token (`base64url(payload).sig`) with the store's token secret. */
    issueToken(user: {
        id?: string | null;
        sub?: string | null;
        username?: string | null;
        name?: string | null;
        roles?: string[];
    }): string;
    /** Verify an HMAC session token; null if invalid or expired (30 s skew). */
    authenticateToken(tokenString: string): OKDBSessionClaims | null;
    /** Extract the value of an `Authorization: Bearer <token>` header, or null. */
    parseBearer(header: string | null | undefined): string | null;

    /** OAuth allowlist check (`auth.oauth.allowedEmails` / `allowedDomains`); false when neither is set. */
    isOAuthEmailAllowed(email: string | null | undefined): boolean;
    /** Open-mode warning text, or null in secure mode. */
    getOpenWarning(): string | null;
    getSecurityNotices(): OKDBSecurityNotice[];
    /** Login-page configuration as served to the admin UI. */
    getLoginConfig(): OKDBLoginConfig;
}
