export interface OKDBToken {
    id: string;
    sub: string;
    roles: string[];
    createdAt: number;
    expiresAt: number | null;
    [key: string]: unknown;
}

export interface OKDBAuthContext {
    authenticated: boolean;
    sub?: string;
    roles?: string[];
    token?: OKDBToken;
    [key: string]: unknown;
}

export interface OKDBLoginResult {
    token: string;
    expiresAt: number;
}

export declare class OKDBAuth {
    start(systemEnv: unknown, options?: Record<string, unknown>): Promise<void>;
    authenticateRequest(req: unknown): Promise<OKDBAuthContext>;
    login(username: string, password: string): Promise<OKDBLoginResult>;
    createToken(options: { sub: string; roles?: string[]; ttl?: number }): Promise<string>;
    revokeToken(tokenId: string): Promise<boolean>;
    listTokens(options?: { limit?: number }): Promise<OKDBToken[]>;
    getToken(tokenId: string): OKDBToken | null;
}
