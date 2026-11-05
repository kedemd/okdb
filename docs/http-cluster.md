# HTTP Clustering

By default, the `okdb` CLI runs across **N identical capable worker processes** that share
the listen port: each one serves HTTP + SSE **and** participates in processing. There is **no
privileged processor** — the 1-of-N processor lease distributes claims across the workers
(cooperative hold-window rotation load-shares under sustained backlog), and each worker drains
its claims in bounded quanta, so a heavy drain on one worker never blocks the others. A dead
worker's claims fail over to the survivors. The supervisor is a thin **passive** process (it
launches/relaunches the workers and seeds the shared token secret; it does not serve or process).

This is a **CLI feature** (the `okdb` command). The embedded library
(`new OKDB(...).http.listen(port)`) always serves from the calling process —
`http.listen(port, { workers })` throws `HTTP_CLUSTER_REMOVED`. For multi-process embedding, run
**N independent full nodes** (each its own `new OKDB(path).http.listen(port)`) on the same data
path behind your own load balancer, or use Node's `cluster` module: they coordinate through the
shared LMDB files + bus + the 1-of-N lease exactly like the CLI's workers. See
[Embedded clustering](#embedded-clustering).

---

## Process model

```
                ┌──────────────────────────────────────────────┐
                │ supervisor  (PASSIVE — processors:false,       │
                │             engines:false, compaction:false)   │
                │  • binds one SO_REUSEPORT socket per worker    │
                │  • launches/relaunches/decommissions workers   │
                │  • owns the ~processes registry (publishes a   │
                │    row per worker; workers are registry-passive)│
                │  • opens its instance BEFORE launching (seeds   │
                │    the shared __tokenSecret so workers agree)   │
                │  • no HTTP server; does NOT process            │
                └───────────────┬──────────────────────────────┘
                                │ launches N (same okdb binary)
        ┌───────────────┬───────┴───────┬───────────────┐
        ▼               ▼               ▼               ▼
   ┌─────────┐    ┌─────────┐     ┌─────────┐     ┌─────────┐
   │ worker  │    │ worker  │ ... │ worker  │     │ worker  │   CAPABLE role:
   │HTTP+proc│    │HTTP+proc│     │HTTP+proc│     │HTTP+proc│   processors:true
   └─────────┘    └─────────┘     └─────────┘     └─────────┘   (serve + process +
        └──────────── one port, kernel-balanced ────┴───────────┘  compact)
```

- **Workers = N identical capable nodes.** The supervisor re-executes the same native `okdb`
  launcher once per worker (same arguments, plus a worker marker in the environment), handing it
  its listening socket and an IPC channel. Each worker opens a **full-role** instance
  (`processors:true`) and both serves HTTP + SSE **and** processes — it claims the 1-of-N
  processor lease, builds/indexes FTS + views, and drains its claims in bounded quanta. Claims **distribute** across the workers (no
  privileged processor); a dead worker's leases lapse and the survivors re-claim. Workers are
  **registry-passive** (the supervisor publishes their `~processes` rows; each worker
  reports its stats and processing facet to the supervisor over IPC so cluster processing stays
  visible).
- **Supervisor = passive.** It opens a passive instance (`processors:false`, `engines:false`,
  `compaction:false`) only to seed the shared `__tokenSecret` before launching workers and to own
  the registry. It runs no HTTP server, never processes, and is **not** in the connection path.
- **`workers:1`** (or `--no-cluster`) is byte-identical to the single-process path: one full
  capable process serves + processes.

A write on any worker is indexed by whichever worker holds the lease (cross-process POKE + the
shared changelog); bounded quanta keep that indexing from monopolizing the holder's loop.

### Connection distribution

The supervisor binds one listening socket per worker slot on the same address and port, all with
`SO_REUSEPORT`, and each worker inherits its own. The **kernel** distributes new connections
across those sockets (by connection hash), and each worker `accept()`s on its own socket — so a
busy supervisor never delays a new connection, and established connections go straight to their
worker. A slot's socket is kept across a worker relaunch. Distribution is even on average, not
strict rotation.

---

## The `workers` knob

The CLI resolves the worker count from the first source present, highest priority first:

| Priority | Source              | Notes                                       |
| -------- | ------------------- | ------------------------------------------- |
| 1        | `--no-cluster`      | Forces `workers:1` (single-process escape). |
| 2        | `--workers N`       | Explicit flag.                              |
| 3        | `OKDB_HTTP_WORKERS` | Environment variable.                       |
| 4        | `http.workers`      | `.kdbconfig` config file.                   |
| 5        | _default_           | `max(1, cores − 1)` (available CPUs).       |

A non-integer or `< 1` explicit value falls back to `1` with a warning. The default leaves one core
for the OS / the thin passive supervisor and runs N capable workers on the rest (each serves HTTP
_and_ processes); on a single-core box it collapses to one process.

```bash
okdb                       # default: max(1, cores − 1) HTTP workers
okdb --workers 4           # 4 workers
okdb --no-cluster          # single process
OKDB_HTTP_WORKERS=3 okdb   # 3 workers
```

```json
// .kdbconfig
{ "http": { "workers": 4 } }
```

### Bind address: `http.host`

By default the CLI listens on every interface. `http.host` (next to `http.workers`) binds the API
to one address or an array of them — in single-process mode and in every cluster worker; the
registry's `listenAddr` shows it. There is no `--host` flag.

```json
// .kdbconfig — loopback only (e.g. behind a local reverse proxy)
{ "http": { "host": "127.0.0.1" } }
```

### Role flags in `.kdbconfig`

The config file also takes the constructor role flags as top-level booleans — the same names and
semantics as `new OKDB(path, { processors, engines, compaction })` (see
[Roles & Deployment](./deployment.md)). They apply to the single-process node and to **every**
cluster worker; absent keys keep the constructor default (`true`), and a non-boolean value is a
startup error. (The supervisor is always passive, whatever the config says.) There is no CLI
flag for them.

```json
// .kdbconfig — a passive serving node: serves HTTP, never claims a lease, never compacts
{ "processors": false, "engines": false, "compaction": false }
```

---

## Cross-process coordination

Workers share the per-env Hybrid Logical Clock and changelog clock counter through a
cross-process shared-memory segment built into okdb's native core (nothing extra to install), so
every worker mints unique, causally ordered clocks. The 2.x "shmbuf native binding missing →
forced single-process" fallback does not apply in 3.0.

Check readiness with `okdb doctor`:

```text
✓ cluster: ready (7 workers)
```

---

## SSE / log coherence boundary

The cluster exposes two distinct event domains. Knowing which is which explains what an SSE
client on a given worker will and won't see:

- **Data changes are cluster-wide.** Each worker runs a **change-feed**: it subscribes to the
  bus `SYSTEM_POKE` signal and, per poke, reads the shared changelog to
  reconstruct data-change events (item put/remove, index, view, type). A write committed on
  worker A surfaces in worker B's SSE within the poke window. The bus carries the **signal**;
  the **data** is read from shared LMDB — the changelog is the single source of truth.
- **Processing progress is per-worker; the cluster-wide view is the durable registry.** There is
  no privileged processor — each capable worker processes its own claimed leases and emits its own
  ephemeral processing events (view-rebuild progress, FTS/index lifecycle, processor lifecycle) to
  **its own** SSE. The cluster-wide picture is **read** from the durable `~processes` registry:
  each worker reports its processing facet to the supervisor over **IPC**, the supervisor
  stamps it onto the worker's registry row, and any node serves `/api/processors/status` (and
  its deprecated alias `/api/processing/status`) and `/api/cluster/status` from that shared registry. So a processing
  event on worker A is not mirrored into worker B's live SSE, but A's processor **state** is
  visible cluster-wide via the registry-sourced status routes.
- **Worker logs are forwarded to the supervisor's log pipeline** over IPC (tagged `[wN]` per
  worker) so the operator log is unified; they are **not** mirrored into other workers' SSE
  streams (SSE log frames are per-process). Only data changes (via the changelog) are coherent
  across every worker's SSE.

`/api/cluster/status` returns the cluster shape (supervisor pid, worker pids, uptime).

---

## Lifecycle

- **Worker death → the supervisor relaunches** it with bounded backoff
  (`min(4000, 250·2^(failures−1))` ms; the base is `OKDB_CLUSTER_RESPAWN_BACKOFF_MS`) and a
  crash-loop guard (≥ 5 deaths / 10 s per slot stops relaunching that slot; the others keep
  serving). A worker that reports `listening` resets its slot's failure count.
- **Supervisor death → workers exit** (no orphan listeners or locks): the IPC channel closes, with
  a `ppid == 1` backstop.
- **Shutdown** (SIGINT/SIGTERM): each worker stops accepting, drains in-flight requests, then
  closes its instance; a worker still running 3.5 s later is sent SIGTERM.

---

## Embedded clustering

The **library default is single-process**. `new OKDB(...).http.listen(port)` serves from the
calling process and returns an `http.Server`-compatible handle (`address()`, `close()`, the
`'listening'` event); the server itself runs inside okdb's native core.

> **Removed in 2.0:** the embedded `http.listen(port, { workers, makeOkdb, primaryOkdb })` API
> (it **throws `HTTP_CLUSTER_REMOVED`**). A library node never forks — HTTP clustering is a
> **launcher** concern. See [Upgrading to 2.0](upgrade-2.0.md).

Two ways to cluster an embedded app — both are the same **"N identical capable nodes"** shape
(every node serves _and_ processes; the 1-of-N lease distributes the work; no privileged processor):

1. **N independent nodes behind your balancer** (simplest). Run your entry as N separate processes,
   each a full `new OKDB(path).http.listen(port_i)`, and put a load balancer in front. They
   coordinate through the shared LMDB files + bus + the lease — no supervisor needed.
2. **Plain Node `cluster`** (one listen port). Fork your entry; each worker opens a **capable**
   instance and calls `http.listen(port)`. Inside a Node `cluster` worker, okdb binds its own
   `SO_REUSEPORT` socket on that port (the native server cannot take over Node's shared handle),
   so the kernel balances connections across the workers.

<!-- not-runnable: starts worker processes and a long-running server -->

```js
const cluster = require('node:cluster');
const dbPath = './data';
const port = 8080;

if (cluster.isPrimary) {
    // Thin supervisor: open a passive node BEFORE forking to seed the shared __tokenSecret,
    // then fork N capable workers. It does not serve or process.
    const supervisor = new OKDB(dbPath, { processors: false, engines: false, compaction: false });
    await supervisor.open();
    for (let i = 0; i < 4; i++) cluster.fork();
} else {
    // Each worker = an identical CAPABLE node: serves HTTP AND processes (claims leases,
    // drains them in bounded quanta). The lease distributes processing across them.
    const w = new OKDB(dbPath, { processors: true });
    await w.open();
    w.http.listen(port); // its own SO_REUSEPORT socket on the shared port
}
```

For a turnkey cluster (supervisor, relaunch, registry rows, log forwarding), the `okdb` CLI does
all of this for you.
