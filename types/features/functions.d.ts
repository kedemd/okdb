export interface OKDBFunctionDefinition {
    name: string;
    source: string;
    runtime?: string;
    timeout?: number;
    [key: string]: unknown;
}

export interface OKDBFunctionCallOptions {
    timeout?: number;
    env?: string;
    args?: unknown[];
    [key: string]: unknown;
}

export declare class OKDBFunctions {
    register(definition: OKDBFunctionDefinition): Promise<void>;
    unregister(name: string): Promise<void>;
    call(name: string, args?: unknown[], options?: OKDBFunctionCallOptions): Promise<unknown>;
    get(name: string): OKDBFunctionDefinition | null;
    list(): OKDBFunctionDefinition[];
    stop(): Promise<void>;
}
