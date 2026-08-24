# Sync

OKDB includes a peer-to-peer, last-write-wins (LWW) replication system. Nodes sync over HTTP — no central coordinator, no Raft, no consensus protocol. Just pull deltas from peers, compare timestamps, keep the newer one.

---

## How it works

1. Every write increments the local clock and logs a change entry
2. When the clock advances, a UDP multicast poke (`bus:poke`) is sent on the LAN
3. Peers that receive the poke (or poll on a timer) pull a **delta** from the changed node
4. Each incoming change is compared to the local version using HLC timestamp
5. The newer timestamp wins; ties are broken by origin node ID (lexicographic)
6. Applied changes are written through the normal write path (with `origin` set to prevent echo-loops)

This is eventual consistency. It's designed for loosely-coupled multi-node topologies: desktop clusters, distributed edge devices, multi-instance app servers.

---

## Setting up a cluster

### Node configuration

```javascript
const okdb = new OKDB('./node1', {
    auth: {
        tokens: { 'cluster-secret': ['admin'] },
    },
    sync: {
        token: 'cluster-secret',
        address: 'http://192.168.1.10:8080', // this node's public address
    },
});
await okdb.open();
okdb.http.listen(8080);
```

Every node needs:

- `auth.tokens` — includes the sync token so peers can call the delta endpoint
- `sync.token` — shared secret used to authenticate outbound sync HTTP requests
- `sync.address` — the URL other nodes will use to reach this one

### Joining a cluster

```javascript
// Node 2 joins node 1
await okdb.sync.join('http://192.168.1.10:8080');
```

`join` does three things:

1. Registers node 1 as a known peer in `~sync_nodes` type (which itself syncs)
2. Pulls an initial delta from node 1
3. From that point, auto-reconcile keeps them in sync on clock change

### Multi-node example

```javascript
const nodes = [8080, 8081, 8082].map((port) => {
    const okdb = new OKDB(`./node-${port}`, {
        auth: { tokens: { secret: ['admin'] } },
        sync: { token: 'secret', address: `http://localhost:${port}` },
    });
    okdb._port = port;
    return okdb;
});

await Promise.all(nodes.map((k) => k.open()));
for (const node of nodes) node.http.listen(node._port);

// Join node 1 and 2 to node 0
for (const node of nodes.slice(1)) {
    await node.sync.join('http://localhost:8080');
}
```

---

## Sync internals

### Peer registry

Peers are stored in the `~sync_nodes` OKDB type — which is itself synced. So adding a peer on one node propagates to all other nodes automatically, forming a mesh.

Local peer progress (which clock was last seen from each peer) is stored outside of sync in `~system` — it's local state that doesn't replicate.

### Delta endpoint

```
GET /api/sync/delta?from_clock=<N>
Authorization: Bearer <token>
```

Returns up to `delta_limit` (default 500) change records from clock `N` onwards across all sync-enabled environments. Each change includes `_env` so the receiver routes it to the right environment.

### Multi-environment sync

The delta spans **all changelog-enabled user environments** simultaneously. The response carries a `clocks` map (`{ default: N, queue: N, ... }`), and each environment's cursor advances independently. Custom environments created via `createEnvironment` are included automatically — every user env enables its changelog and participates in sync (the per-env `sync` option was removed in 2.0; internal `~`-prefixed envs never participate).

---

## LWW conflict model

When two nodes write the same key concurrently:

- The **higher HLC timestamp** wins
- If timestamps are equal, the **lexicographically larger origin node ID** wins
- This is fully deterministic — every node arrives at the same winner independently

### Anti-echo

Changes that originated on the local node (`origin === okdb.id`) are never re-applied when they arrive back from a peer. This prevents infinite re-broadcast loops.

---

## Sync info and status

```javascript
const info = okdb.sync.info();
// {
//   node_id: '...',
//   clock: 142,
//   auto_reconcile: true,
//   peers: 2,
//   reconciling: [],
// }

// List known peers
const self = okdb.sync.getSelfNode();
// { id, address, meta, updated }
```

---

## Caveats

:::warning Wall-clock drift
LWW depends on timestamps. If two nodes have significantly different system clocks, causally-later writes can lose. NTP keeps this manageable in practice, but be aware of it. HLC mitigates this for rapid local writes, but not cross-node drift.
:::

:::note Non-syncable data
Internal `~`-prefixed environments (FTS indexes under `~fts`, vector stores, the `~sub`
subscriptions env) carry no changelog and are excluded from sync. They are rebuilt locally from
synced data. This is intentional — posting lists and HNSW graphs are large, computable, and
node-local. (In 1.9 these were opted out with `sync: false`; that option was removed in 2.0 —
exclusion is now derived from the env being a rebuildable internal store.)
:::

---

## UDP discovery bus

`okdb-bus` sends a UDP multicast datagram on `239.1.2.3:30303` whenever the clock changes. This is how peers on the same LAN discover that new data is available without polling. Loss is acceptable — sync reconciles correctly even if some pokes are dropped.

The bus is **auto-enabled** when the LMDB path is shared (the shmbuf native binding present);
it is off for a lone single-process node. The `bus` constructor option was removed in 2.0 (it
threw nothing useful as a manual switch — it is load-bearing for POKE/DRAIN coherence and so is
derived, not asked). See [Upgrading to 2.0](upgrade-2.0.md).
