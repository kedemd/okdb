/** A tool entry as advertised by the MCP `tools/list` JSON-RPC method. */
export interface OKDBMcpTool {
    /** e.g. `okdb_data`, `okdb_queue` (one per capability), standalone route tools, and `okdb_api`. */
    name: string;
    description?: string;
    /** JSON Schema of the tool arguments. Capability tools take `{ action, ...args }`. */
    inputSchema: Record<string, unknown>;
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
}

/**
 * Model Context Protocol server, attached as `db.mcp`. It has no public JavaScript methods: it is
 * consumed over HTTP once `db.http.listen(port)` is called — `POST /mcp` (JSON-RPC 2.0:
 * `initialize`, `tools/list`, `tools/call`, ...), `GET /mcp` (SSE notification stream), plus the
 * legacy `/mcp/sse` + `/mcp/messages` transport. Requests need `Authorization: Bearer <token>`
 * unless open mode / the bootstrap window applies. Tools are projected from the HTTP operation
 * registry (routes carrying `mcp: { capability, action }` metadata). CORS headers are sent only
 * when the `mcp.allowedOrigins` constructor option (array of origins, or `'*'`) is set.
 *
 * Removed: `configure`, `listTools`, `callTool` (not part of the 2.x JS API; use the HTTP endpoint).
 */
export declare class OKDBMcp {
    private constructor();
}
