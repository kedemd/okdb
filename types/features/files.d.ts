import type { Readable } from 'stream';
import type { ReadStream } from 'fs';

export interface OKDBFileRecord {
    id: string;
    hash: string;
    size: number;
    mime: string;
    path: string;
    createdAt: number;
}

export interface OKDBUploadOptions {
    id: string;
    stream: Readable;
    mime?: string;
    path?: string;
    txn?: unknown;
}

export interface OKDBBlobStatus {
    refs: number;
    nodes?: Record<string, boolean>;
}

export interface OKDBIndexContentOptions {
    /** Resolved field on `~files` that serves the extracted text (default `'content'`). */
    field?: string;
    /** Files larger than this get no content (default 16 MiB). */
    maxBytes?: number;
}

/** A mime (`'application/pdf'`), a wildcard (`'text/*'`, `'*+json'`), or a predicate. */
export type OKDBExtractorMatch = string | ((record: OKDBFileRecord) => boolean);
export type OKDBExtractor = (buffer: Buffer, record: OKDBFileRecord) => string | null | Promise<string | null>;

export declare class OKDBFiles {
    upload(options: OKDBUploadOptions): Promise<OKDBFileRecord>;
    get(id: string): OKDBFileRecord | null;
    read(id: string): Promise<Buffer>;
    stream(id: string): Promise<{ stream: ReadStream; record: OKDBFileRecord }>;
    remove(id: string, options?: { txn?: unknown }): Promise<void>;
    listPath(prefix: string, options?: { recursive?: boolean; limit?: number }): Promise<OKDBFileRecord[]>;

    /** Make file contents searchable (FTS / embeddings) through a durable resolved field. */
    indexContent(options?: OKDBIndexContentOptions): Promise<void>;
    /** Register a content extractor (process-local; later registrations win). Returns an unregister function. */
    registerExtractor(match: OKDBExtractorMatch, fn: OKDBExtractor): () => void;

    getBlobStatus(hash: string): OKDBBlobStatus | null;
    /** Skips blobs modified in the last `minAgeMs` (default 10 min) — possibly an upload in flight. */
    gcOrphanedBlobs(opts?: { minAgeMs?: number }): number;
    listBlobStatus(): Array<{
        hash: string;
        refs: number;
        nodes: Record<string, boolean>;
        onDisk: boolean;
        sizeBytes: number | null;
    }>;
    streamByHash(hash: string): ReadStream;
    syncBlobs(options?: { peerIds?: string[] }): Promise<{ synced: number; errors: string[] }>;
}
