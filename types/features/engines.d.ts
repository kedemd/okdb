export interface OKDBEngineDefinition {
    name: string;
    source: string;
    affinity?: string[];
    [key: string]: unknown;
}

export interface OKDBEngineRunOptions {
    args?: unknown[];
    timeout?: number;
    env?: string;
    [key: string]: unknown;
}

export declare class OKDBEngines {
    register(definition: OKDBEngineDefinition): Promise<void>;
    unregister(name: string): Promise<void>;
    run(name: string, options?: OKDBEngineRunOptions): Promise<unknown>;
    list(): OKDBEngineDefinition[];
    start(): Promise<void>;
    stop(): Promise<void>;
    bootSyncedEngines(): Promise<void>;
}
