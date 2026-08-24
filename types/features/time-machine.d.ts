import type { OKDBPrimaryKey } from '../options';

export interface OKDBTimeMachineSnapshot {
    clock: number;
    timestamp: number;
    [key: string]: unknown;
}

export interface OKDBTimeMachineDiff {
    key: OKDBPrimaryKey;
    type: string;
    action: 'put' | 'remove';
    oldValue?: unknown;
    newValue?: unknown;
    clock: number;
    timestamp: number;
}

export interface OKDBTimeMachineQueryOptions {
    from?: number;
    to?: number;
    limit?: number;
    types?: string[];
}

export declare class OKDBTimeMachine {
    start(): void;
    stop(): Promise<void>;
    getAt(type: string, key: OKDBPrimaryKey, clock: number): unknown;
    getDiff(options?: OKDBTimeMachineQueryOptions): Iterable<OKDBTimeMachineDiff>;
    listSnapshots(options?: { limit?: number }): OKDBTimeMachineSnapshot[];
}
