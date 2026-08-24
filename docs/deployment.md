# Roles & Deployment

okdb 2.0 has one runtime model: **the process is the control unit**. Every process that opens
a data path declares — at construction — which background work it runs, and okdb never forks
or supervises processes for you. Scale-out is always the same move: **run more okdb processes
on the same path**; the per-processor 1-of-N lease distributes the work automatically, with no
coordinator.

If you only ever run one process, you can stop reading: `new OKDB(path)` is a full
do-everything node and the defaults are correct.

---

## The role flags

```js
new OKDB(path, {
    processors: true, // claim processor leases + drain derived work (default true)
    engines: true, // run embeddings / vector-search engines (default true)
    compaction: true, // eligible to claim the per-env compaction lease (default true)
});
```

| Flag         | `true` (default)                                                                                                          | `false` (passive)                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `processors` | Claim every unclaimed `single` processor lease; drain FTS / views / time-machine / materializer / embeddings on this loop | Claim nothing. Reads, writes, and **inline** processors (indexes, schema, FK, TTL) still run |
| `engines`    | Run queue worker engines, pipeline workers, embeddings engines                                                            | None of those start here                                                                     |
| `compaction` | Eligible to claim the per-env compaction lease                                                                            | Never auto-compacts (`env.compact()` still works when called explicitly)                     |

Three things to internalize:

- **Roles are policy, not placement.** A passive node is a full read/write citizen — its writes
  land in the changelog and are indexed by whichever participating node holds the lease. Inline
  processors are mandatory on every writer regardless of role.
- **The lease is the load balancer.** With N participating nodes, each `single` processor is
  claimed by exactly one; a dead node's leases lapse and survivors re-claim. Under sustained
  backlog holders rotate work in cooperative hold windows. See [Processors](./processors.md).
- **Ephemeral processes should be passive.** A CLI one-shot or short-lived script that grabs a
  1-of-N lease and exits mid-quantum just thrashes it — pass `processors: false`.

---

## Topologies

### 1. One embedded process (the default)

```js
const db = new OKDB('./data');
await db.open();
```

Serves your app's reads/writes and does all derived work on its own loop, in bounded quanta.
This is crash-safe and correct on its own; you add processes when you decide you need them.

### 2. Embedded + HTTP

```js
db.http.listen(8080); // returns a plain http.Server
```

Same single process, plus the REST API and admin UI. The embedded server is always
single-process — `http.listen(port, { workers })` throws `HTTP_CLUSTER_REMOVED`.

### 3. N capable nodes (the CLI's shape)

Run N identical full-role processes on the same path — either via `bin/okdb` (shared listen
socket, thin passive supervisor; see [HTTP Clustering](./http-cluster.md)) or as N independent
`new OKDB(path)` + `http.listen()` processes behind your own load balancer. Each node serves
**and** processes; the leases spread the processors across them and fail over when a node dies.

### 4. Dedicated workers + a passive serving node

When you want the serving loop insulated from heavy backfill/indexing work:

```js
// serving process — loop only serves; never claims, never compacts
const front = new OKDB(path, { processors: false, engines: false, compaction: false });
front.http.listen(8080);

// N worker processes — headless, do all the processing
const worker = new OKDB(path, { processors: true }); // engines/compaction default true
```

Workers need no ports: coordination is the shared LMDB + the UDP bus. Placement and respawn
are your launcher's job (systemd, pm2, docker, k8s, a PowerShell script — anything that can
start N processes).

**Boot order tip:** start processes one at a time — wait until a node has fully opened (e.g.
it bound its port, or touched a ready-file of your choosing) before starting the next, so
concurrent first-opens of the same envs never race.

---

## Dynamic participation: `processors.start()` / `processors.stop()`

The `processors` constructor option is only the **initial** state — participation is
controlled at runtime:

```js
db.processors.start(); // begin participating: un-gate claiming, run the deferred view boot
db.processors.stop(); //  cease: finish in-flight quanta, release leases (peers fail over)
```

Both are idempotent and resolve `true` when the state actually changed. `stop()` never
touches reads, writes, or inline processors — the node stays a full read/write citizen.

**Fast startup** falls out of this: open without participating, start once your service is up.

```js
const db = new OKDB(path, { processors: false });
await db.open(); // fast — no view boot, no FTS/TM drains competing with your startup

app.listen(PORT, async () => {
    await db.processors.start(); // now begin claiming + draining
});
```

**Maintenance windows** too: `stop()` during a heavy backfill to keep this node's loop free,
`start()` after — the leases redistribute to peers and back via normal failover.

---

## Controlling processors at runtime

Static role flags decide _participation_; the running system is controlled per processor
through durable desired-state (applies across every process, no IPC):

- **Node-level participation** — `db.processors.start()` / `stop()` (see above); this-process,
  in-memory.
- **Pause / resume / retry / cursor reset** — per processor, from the admin UI's Processors
  view or `stop.pause()` / `stop.resume()` on the registration handle. A durable pause
  survives restarts and re-claims (cross-process, unlike node-level start/stop).
- **Mode switching** — `setMode(logicalKey, mode)` flips a processor between sync/async at a
  clock boundary. See [Processors](./processors.md).
- **Observability** — `GET /api/processors/status` (per-processor durable lag — the honest
  backlog signal from any node), `GET /api/processes/tree` (the census of OS processes on the
  root), and the per-env Write queue (`depth`, `oldestPendingMs` — the stall tell). These are
  the signals an external autoscaler would watch; the scaling _policy_ lives with your
  launcher, not inside okdb.
- **`db.pressure()`** — the composite of those signals for THIS node (writer stall/depth, max
  durable lag, queue backlog, loop lag, and a normalized `score`), cached 250 ms. Feed it to a
  queue consumer's `admission` option (`() => db.pressure().score < 1`) for load-aware
  consumption, or poll it from your orchestrator. See docs/queue.md → "Load-aware consumers".

---

## Liveness guarantees (what you can rely on)

- Cross-process wakes ride the UDP bus; because UDP is lossy, every participating node also
  runs an idle **catch-up tick** (`OKDB_PROCESSOR_CATCHUP_MS`, default 15 s) that drains any
  backlog a lost poke left behind — a write from a short-lived process is picked up within
  one tick, not "whenever the next write happens".
- The **changelog is never pruned past the slowest processor cursor**, so a lagging drain
  finds its entries intact instead of silently skipping writes. A durably paused processor
  therefore pins changelog growth — visible and recoverable, by design.
