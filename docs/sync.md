# Sync

OKDB includes a peer-to-peer, last-write-wins (LWW) replication system. Nodes sync over HTTP — no central coordinator, no Raft, no consensus protocol. Just pull deltas from peers, compare timestamps, keep the newer one.

---

## How it works

1. Every write increments the local clock and logs a change entry
2. When the clock advances, the node pulls from each known peer and then pokes it over HTTP (`POST /api/sync/poke`)
3. A poked peer pulls a **delta** (`POST /api/sync/delta`) from the changed node
4. Each incoming change is compared to the local version using HLC timestamp
5. The newer timestamp wins; ties are broken by origin node ID (lexicographic)
6. Applied changes are written through the normal write path (with `origin` set to prevent echo-loops)

This is eventual consistency. It's designed for loosely-coupled multi-node topologies: desktop clusters, distributed edge devices, multi-instance app servers.

---

## Setting up a cluster

### Node configuration

```javascript
const okdb = new OKDB('./node1', {
    sync: {
        address: 'http://192.168.1.10:8080', // this node's public address
    },
});
await okdb.open();
okdb.http.listen(8080);
```

Every node needs `sync.address` — the URL other nodes will use to reach this one. There is no
shared cluster secret: each node has its own Ed25519 keypair, and peers authenticate every sync
request by signature against the public keys stored in `~sync_nodes`. (`sync.token` is an
optional Bearer also sent on peer requests, as a fallback while a peer has not yet received this
node's public key.) See [Auth and Sync](./auth-and-sync.md#part-2--sync) for the details and the
full `sync` option table.

### Joining a cluster

Joining needs a credential on the remote **once** — a token that exists in node 1's `~tokens`
with `sync:read` + `sync:peer`, or a token name + password:

```bash
# on node 1
okdb token create --label 'cluster join' --permissions 'sync:read,sync:peer'
```

```javascript
// Node 2 joins node 1
await okdb.sync.join('http://192.168.1.10:8080', { token: process.env.OKDB_JOIN_TOKEN });
// or: { username, password }
```

`join` does four things:

1. Registers node 1 as a known peer in `~sync_nodes` type (which itself syncs) and creates a data link
2. Sends this node's record (with its public key) to node 1's `/api/sync/join`
3. Pulls an initial delta from node 1
4. From that point, auto-reconcile keeps them in sync on clock change — with signed requests

### Multi-node example

```javascript
const nodes = [8080, 8081, 8082].map((port) => {
    const okdb = new OKDB(`./node-${port}`, {
        sync: { address: `http://localhost:${port}` },
    });
    okdb._port = port;
    return okdb;
});

await Promise.all(nodes.map((k) => k.open()));
for (const node of nodes) node.http.listen(node._port);

// Join node 1 and 2 to node 0, using a join token created on node 0
for (const node of nodes.slice(1)) {
    await node.sync.join('http://localhost:8080', { token: joinToken });
}
```

---

## Sync internals

### Peer registry

Peers are stored in the `~sync_nodes` OKDB type — which is itself synced. So adding a peer on one node propagates to all other nodes automatically, forming a mesh.

Local peer progress (which clock was last seen from each peer) is stored outside of sync in `~system` (the raw `__sync:peer_state` sub-db) — it's local state that doesn't replicate.

### Delta endpoint

```
POST /api/sync/delta
Content-Type: application/json

{ "from_clocks": { "default": 120, "~system": 40 }, "limit": 500, "envs": null }
```

Returns `{ clock, clocks, changes }` (+ `denied` when requested envs were outside the link): up
to `limit` change records after each env's clock (the puller asks for its `delta_limit`, default 500) across the changelog-enabled environments the requester may pull (see Data links above).
Each change includes `_env` so the receiver routes it to the right environment. The request is
Ed25519-signed by the pulling node.

### Data links (scope and direction)

Once any link exists (`join()` creates a bidirectional one unless `dataLink: false`), data flows
only over links — `okdb.sync.upsertLink(peerId, { direction, envs, enabled })`, or
`PUT /api/sync/links/:nodeA/:nodeB`:

- `direction` — `both`, `lo_to_hi` or `hi_to_lo`, canonical over the alphabetically sorted node
  pair (`lo_to_hi`: the lower id sends, the higher id receives).
- `envs` — the data envs the link carries; `null` = all.

The link is **enforced on both ends, not trusted from the request**. The node serving
`/api/sync/delta` serves a signed peer only `~system` plus the data envs the link lets it send to
that peer — asking for another env (or pulling against the link's direction) gets those envs
omitted and listed in the response's `denied`. The pulling node applies only envs it asked for and
the link lets it receive, whatever a peer sends. A signed `/api/sync/poke` only triggers a pull
from the signer, and a pull with no explicit env list (join, poke, `reconcilePeer`) asks for the
link's envs only.

`~system` is the control plane and always flows with every registered peer, link or not: it
carries `~sync_nodes`, `~sync_links`, `~envs`, `~tokens`, `~licenses`, engine and pipeline
declarations. So a link scopes _data_, not trust — see
[Auth and Sync → What a peer can do](./auth-and-sync.md#what-a-peer-can-do). With no link anywhere
the cluster runs in legacy full-mesh mode (every env with every peer).

### Multi-environment sync

The delta spans **every open changelog-enabled environment** simultaneously — every user env, plus `~system` (the control plane: `~sync_nodes`, `~tokens`, …) and the embeddings vector envs (`~<env>:emb:<type>`). The response carries a `clocks` map (`{ default: N, '~system': N, ... }`), and each environment's cursor advances independently. Custom environments created via `createEnvironment` are included automatically — every user env enables its changelog and participates in sync (the per-env `sync` option was removed in 2.0 for user envs).

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

// This node's own peer record (known peers: GET /api/sync/peers)
const self = okdb.sync.getSelfNode();
// { id, address, meta, tags, updated, publicKey, ... }
```

---

## Caveats

:::warning Wall-clock drift
LWW depends on timestamps. If two nodes have significantly different system clocks, causally-later writes can lose. NTP keeps this manageable in practice, but be aware of it. HLC mitigates this for rapid local writes, but not cross-node drift.
:::

:::note Non-syncable data
Not replicated — rebuilt or kept per node:

- **Derived indexes and state**: FTS posting lists (separate `~fts/` LMDB files), secondary
  indexes, view state, time-machine history and the in-memory HNSW search graphs. Each node
  rebuilds them locally from the synced data.
- **Changelog-less internal envs**: `~sub` (subscriptions), `~log`, `~processes` — opened
  `sync: false`, so they have nothing to ship.
- **Node-local `~system` state**: identity + keypair, `__tokenSecret`, locks, processor cursors,
  peer progress (raw keys / sub-dbs, not in the changelog), and — as of 2.4.0 — the
  `~migrations` log, which records which layout migrations ran on _this_ store's files and is
  never sent in or applied from a delta.

Vector data **does** replicate: the raw vectors live in the changelog-enabled
`~<env>:emb:<type>` envs, so an expensive embedding is computed once and shipped; each node
reconciles its search graph against the synced vectors (see [Embeddings](./embeddings.md)).
:::

---

## UDP discovery bus

`okdb-bus` sends UDP multicast datagrams on `239.1.2.3:30303` (POKE on commit, DRAIN on
compaction, …) so that the **processes sharing one store path** hear each other's writes — a
write in a passive HTTP worker wakes the process that drives sync, which then reconciles and
pokes its peers. It is not how peer nodes learn about new data; that is the HTTP poke above.
Loss is acceptable — sync reconciles correctly even if some pokes are dropped.

Pokes are **throttled per `(env, type)`**: the first change sends immediately, further changes
inside the window collapse into one trailing send, so a sustained writer emits ~one datagram per
window per type rather than one per changed document. The window is
`OKDB_BUS_POKE_WINDOW_MS` (default `10`; `0` = unthrottled). Control signals (DRAIN,
ENV_RELEASE, PROC, TYPE_DROP) are never throttled.

The bus is **enabled whenever the shmbuf native binding is present**, but a poke only goes on
the wire when another instance holds the env: at each send the writer checks the env's shared
writer cells, and if it is the only holder the poke is delivered in-process instead (same-process
listeners — changefeed, `~sub` reload — still fire; no datagram). A peer that opens the env
mid-window receives the trailing poke. Packets are framed with a per-store identity, so other
okdb processes on the host drop a store's packets without acting on them. The `bus`
constructor option was removed in 2.0 (it is load-bearing for POKE/DRAIN coherence and so is
derived, not asked). See [Upgrading to 2.0](upgrade-2.0.md).
