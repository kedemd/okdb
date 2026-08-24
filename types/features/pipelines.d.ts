export interface OKDBPipelineDefinition {
    name: string;
    sourceType: string;
    steps: OKDBPipelineStep[];
    [key: string]: unknown;
}

export interface OKDBPipelineStep {
    type: string;
    [key: string]: unknown;
}

export declare class OKDBPipelines {
    register(definition: OKDBPipelineDefinition): Promise<void>;
    unregister(name: string): Promise<void>;
    get(name: string): OKDBPipelineDefinition | null;
    list(): OKDBPipelineDefinition[];
    bootSyncedPipelines(): Promise<void>;
}
