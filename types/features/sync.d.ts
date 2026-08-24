export interface OKDBSyncNode {
    id: string;
    address: string | null;
    meta: Record<string, unknown>;
    tags: string[];
    updated: number;
    publicKey?: string;
}

export interface OKDBSyncLink {
    id: string;
    nodeA: string;
    nodeB: string;
    createdAt: number;
    [key: string]: unknown;
}

export interface OKDBSyncInfo {
    node_id: string;
    clock: number;
    auto_reconcile: boolean;
    peers: number;
    reconciling: string[];
}

export declare class OKDBSync {
    info(): OKDBSyncInfo;
    getSelfNode(): OKDBSyncNode;
    addPeer(address: string, options?: Record<string, unknown>): Promise<void>;
    removePeer(nodeId: string): Promise<void>;
    listPeers(): OKDBSyncNode[];
    reconcile(nodeId?: string): Promise<void>;
    stop(): void;
}
