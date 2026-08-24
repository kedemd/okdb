export interface OKDBApiSchemaField {
    name: string;
    types: string[];
}

export interface OKDBApiTypeSchema {
    type: string;
    fields: OKDBApiSchemaField[];
    indexes: string[][];
    count: number;
}

export declare class OKDBApi {
    /** Registers REST API HTTP routes on the parent OKDB's HTTP server. */
    start(): void;
    /** Sample documents from a type and infer a field schema. */
    inferSchema(type: string, limit?: number): Promise<OKDBApiTypeSchema>;
}
