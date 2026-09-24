/// <reference lib="es2015.generator" />
import type { OKDBPrimaryKey } from '../options';

/**
 * The current snapshot ("head") the time machine keeps for a tracked document —
 * the last value it recorded and the clock it was recorded at.
 */
export interface OKDBTimeMachineSnapshot {
    value: unknown;
    clock: number;
}

/**
 * One field-level diff. Paths are dot-notation (nested only where the type's schema
 * declares nested object properties). A create is all `put`; a remove is all `delete`.
 */
export interface OKDBTimeMachineDiff {
    /** Env clock the diff was recorded at. */
    clock: number;
    /** Fields set or updated at this clock (path → new value). */
    put: Record<string, unknown>;
    /** Field paths removed at this clock. */
    delete: string[];
    /** The previous head clock (0 for the initial snapshot / a create). */
    fromClock: number;
    /** Wall-clock ms when the diff was recorded. */
    timestamp: number;
}

/** A diff yielded by `getChanges()` — carries the type and document key it belongs to. */
export interface OKDBTimeMachineChange extends OKDBTimeMachineDiff {
    type: string;
    key: OKDBPrimaryKey;
}

export interface OKDBTimeMachineHistoryOptions {
    /** Max diffs returned. */
    limit?: number;
    /** Only diffs with clock > after. */
    after?: number;
    /** Only diffs with clock <= maxClock. (The HTTP route's `before` query param maps here.) */
    maxClock?: number;
}

/** Returned by `getHistory()`: ascending diffs plus the current head (null if none / removed). */
export interface OKDBTimeMachineHistory {
    diffs: OKDBTimeMachineDiff[];
    head: OKDBTimeMachineSnapshot | null;
}

/** One row of `list()` — every non-`~` type in the env, sorted by name. */
export interface OKDBTimeMachineTypeListEntry {
    type: string;
    enabled: boolean;
    /** Processor state; 'remote' = enabled but indexed by another (processors-role) instance. */
    state: string;
    lastClock: number;
    /** null when this instance does not run the type's processor. */
    lag: number | null;
}

/** Returned by `status(type)`. Also carries the type's processor status fields when it runs locally. */
export interface OKDBTimeMachineTypeStatus {
    type: string;
    /** True only when this instance runs the type's processor. */
    enabled: boolean;
    startClock: number | null;
    lastProcessedClock: number | null;
    headCount: number;
    [key: string]: unknown;
}

/** Returned by `status()` with no argument. */
export interface OKDBTimeMachineStatus {
    enabled: boolean;
    autoEnable: boolean;
    startClock: number | null;
    lastProcessedClock: number | null;
    envClock: number | null;
    headCount: number;
    disabledAt: null;
    types: OKDBTimeMachineTypeListEntry[];
}

/**
 * Per-type field-level document history (`env.timeMachine`). Attached only when the
 * `timeMachine` constructor option is truthy and the license allows the feature;
 * otherwise `env.timeMachine` is undefined. Tracking is an async `single` processor per type.
 */
export declare class OKDBTimeMachine {
    /**
     * Start tracking `type`. First enable seeds a head + diff for every existing doc; re-enable
     * after `disable()` resumes from the kept cursor; re-enable after `drop()` re-seeds.
     */
    enable(type: string): Promise<void>;
    /** @deprecated use enableAll() */
    enable(): Promise<void>;
    /** Stop tracking `type`; history is kept and queryable. */
    disable(type: string): Promise<void>;
    /** @deprecated use disableAll() — note: the no-arg form does not clear the auto-enable flag. */
    disable(): Promise<void>;
    /** Stop tracking `type` and delete its diffs + heads; resets its cursor. */
    drop(type: string): Promise<void>;
    /** @deprecated use dropAll() */
    drop(): Promise<void>;
    /** Enable every current non-`~` type and auto-enable types registered later. */
    enableAll(): Promise<void>;
    /** Disable every tracked type and clear auto-enable. History is kept. */
    disableAll(): Promise<void>;
    /** Delete all history for every type and reset all cursors. */
    dropAll(): Promise<void>;

    /** Is `type` tracked? With no argument: is any type tracked? */
    isEnabled(type?: string): boolean;
    /** Every non-`~` type in the env with its tracking state. */
    list(): OKDBTimeMachineTypeListEntry[];
    status(type: string): OKDBTimeMachineTypeStatus;
    status(): OKDBTimeMachineStatus;
    /** The type's durable processor cursor (clock). */
    getCursor(type: string): number;
    /** @deprecated pass a type — returns the max cursor across locally running types. */
    getCursor(): { lastProcessedClock: number } | null;

    /** Reconstruct the document as of `clock`; undefined if no diff exists at or before it. */
    getStateAt(type: string, key: OKDBPrimaryKey, clock: number): Record<string, unknown> | undefined;
    getHistory(type: string, key: OKDBPrimaryKey, options?: OKDBTimeMachineHistoryOptions): OKDBTimeMachineHistory;
    /** Diffs with fromClock <= clock <= toClock for `type`, or for all types when `type` is null. */
    getChanges(
        type: string | null,
        fromClock: number,
        toClock: number,
    ): Generator<OKDBTimeMachineChange, void, undefined>;
}
