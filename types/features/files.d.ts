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

export declare class OKDBFiles {
    upload(options: OKDBUploadOptions): Promise<OKDBFileRecord>;
    stream(id: string): Promise<{ stream: ReadStream; record: OKDBFileRecord }>;
    delete(id: string): Promise<boolean>;
    get(id: string): OKDBFileRecord | null;
    list(options?: { limit?: number; path?: string }): Iterable<OKDBFileRecord>;
    start(): Promise<void>;
    stop(): void;
}
