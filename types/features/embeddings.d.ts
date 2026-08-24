export interface OKDBEmbeddingsPipeline {
    name: string;
    sourceType: string;
    sourceField: string;
    model: string;
    algorithm: string;
    [key: string]: unknown;
}

export interface OKDBEmbeddingsSearchResult {
    key: string | number;
    score: number;
    value?: unknown;
}

export interface OKDBEmbeddingsSearchOptions {
    limit?: number;
    filter?: Record<string, unknown>;
    includeValues?: boolean;
}

export interface OKDBEmbeddingsAddPipelineOptions {
    sourceField: string;
    model: string;
    algorithm?: string;
    dims?: number;
    [key: string]: unknown;
}

export declare class OKDBEmbeddings {
    addPipeline(
        name: string,
        sourceType: string,
        options: OKDBEmbeddingsAddPipelineOptions,
    ): Promise<OKDBEmbeddingsPipeline>;
    removePipeline(name: string, sourceType: string): Promise<void>;
    getPipeline(name: string, sourceType: string): OKDBEmbeddingsPipeline | null;
    listPipelines(sourceType?: string): OKDBEmbeddingsPipeline[];
    search(
        name: string,
        sourceType: string,
        query: string | number[],
        options?: OKDBEmbeddingsSearchOptions,
    ): Promise<OKDBEmbeddingsSearchResult[]>;
    embed(model: string, text: string | string[]): Promise<number[] | number[][]>;
    start(): Promise<void>;
    stop(): Promise<void>;
}
