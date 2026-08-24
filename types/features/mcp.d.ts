export interface OKDBMcpTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface OKDBMcpOptions {
    tools?: OKDBMcpTool[];
    [key: string]: unknown;
}

export declare class OKDBMcp {
    configure(options: OKDBMcpOptions): void;
    listTools(): OKDBMcpTool[];
    callTool(name: string, input: unknown): Promise<unknown>;
}
