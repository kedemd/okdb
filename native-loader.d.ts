export type PlatformKey = 'linux-x64-gnu' | 'linux-arm64-gnu' | 'linux-x64-musl' | 'linux-arm64-musl';
export interface Located { path: string | null; key: PlatformKey | null; source?: 'env' | 'bundled' | 'package'; reason?: string; unsupported?: boolean }
export type Probe =
    | { ok: true; mod: unknown; path: string; key: PlatformKey | null; source?: string; bindingVersion: string | null }
    | { ok: false; reason: string; unsupported?: boolean; error?: Error };
export function platformKey(): PlatformKey | null;
export function packageName(key: PlatformKey): string;
/** "linux/x64/glibc", "darwin/arm64" */
export function describeHost(): string;
/** the platform keys bundled under native/ in this package (3.0: ['linux-x64-gnu']) */
export function bundledKeys(): PlatformKey[];
/** the stable bundled path: <pkg>/native/<key>/okdb-node.<key>.node (addon) or <pkg>/native/<key>/okdb (launcher) */
export function bundledPath(key: PlatformKey, kind: 'addon' | 'launcher' | 'cli'): string;
export function loadedPath(): string | null;
export const BUNDLED_DIR: 'native';
export function locate(kind: 'addon' | 'launcher' | 'cli'): Located;
export function probe(): Probe;
export function load(): unknown;
export function isMusl(): boolean;
export const KEYS: PlatformKey[];
