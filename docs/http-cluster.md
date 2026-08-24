# HTTP Clustering

By default, the `okdb` CLI runs across **N identical capable worker processes** that share
the listen socket: each one serves HTTP + SSE **and** participates in processing. There is **no
privileged processor** — the 1-of-N `OKDBLock` lease distributes claims across the workers
(cooperative hold-window rotation load-shares under sustained backlog), and each worker drains
its claims on its own loop in bounded quanta, so a heavy drain on one worker never blocks the
others. A dead worker's claims fail over to the survivors. The Node-cluster primary is a thin
**passive supervisor** (it forks/respawns the workers and seeds the shared token secret; it
does not serve or process).

This is a **CLI-only feature** (`okdb` / `bin/okdb`). The embedded library
(`new OKDB(...).http.listen(port)`) is always single-process — `http.listen({workers})` was
removed in 2.0. For multi-process embedding, run **N independent full nodes** (each its own
`new OKDB(path).http.listen(port)`) on the same data path behind your own load balancer: they
already coordinate through the shared LMDB + bus + the 1-of-N lease exactly like the CLI's
workers (this is the same "N capable nodes" shape, just supervised by your balancer instead of
`bin/okdb`). See [Embedded clustering](#embedded-clustering).

---

## Process model

```
                ┌──────────────────────────────────────────────┐
                │ supervisor  (PASSIVE — processors:false,       │
                │             engines:false, compaction:passive) │
                │  • forks/respawns/decommissions the workers    │
                │  • owns the ~processes registry (publishes a   │
                │    row per worker; workers are registry-passive)│
                │  • opens its OKDB BEFORE forking (seeds the     │
                │    shared __tokenSecret so workers agree)       │
                │  • HTTP-SILENT; does NOT process                │
                └───────────────┬──────────────────────────────┘
                                │ forks N
        ┌───────────────┬───────┴───────┬───────────────┐
        ▼               ▼               ▼               ▼
   ┌─────────┐    ┌─────────┐     ┌─────────┐     ┌─────────┐
   │ worker  │    │ worker  │ ... │ worker  │     │ worker  │   CAPABLE role:
   │HTTP+proc│    │HTTP+proc│     │HTTP+proc│     │HTTP+proc│   processors:true
   └─────────┘    └─────────┘     └─────────┘     └─────────┘   (serve + process +
        └───────────────┴── shared listen socket ──┴───────────┘  compact)
```

- **Workers = N identical capable nodes.** Each forked worker opens a **full-role** OKDB
  (`processors:true`) and both serves HTTP + SSE on the shared socket **and** processes — it
  claims the 1-of-N `OKDBLock` lease, builds/indexes FTS + views, and drains its claims on its
  own loop in bounded quanta. Claims **distribute** across the workers (no
  privileged processor); a dead worker's leases lapse and the survivors re-claim. Workers are
  **registry-passive** (the supervisor publishes their `~processes` rows; a capable worker
  reports its processing facet to the supervisor over IPC so cluster processing stays visible).
- **Supervisor = passive.** It opens a passive OKDB (`processors:false`, `engines:false`,
  `compaction:false`) only to seed the shared `__tokenSecret` before forking and to own the
  registry. It is HTTP-silent and never processes.
- **`workers:1`** (or `--no-cluster`) is byte-identical to the single-process path: one full
  capable process serves + processes.

A write on any worker is indexed by whichever worker holds the lease (cross-process POKE + the
shared changelog); bounded quanta keep that indexing from monopolizing the holder's loop.

---

## The `workers` knob

The CLI resolves the worker count from the first source present, highest priority first:

| Priority | Source              | Notes                                          |
| -------- | ------------------- | ---------------------------------------------- |
| 1        | `--no-cluster`      | Forces `workers:1` (single-process escape).    |
| 2        | `--workers N`       | Explicit flag.                                 |
| 3        | `OKDB_HTTP_WORKERS` | Environment variable.                          |
| 4        | `http.workers`      | `.kdbconfig` config file.                      |
| 5        | _default_           | `max(1, cores − 1)` where `cores = os.cpus()`. |

A non-integer or `< 1` explicit value clamps to `1` with a warning. The default leaves one core
for the OS / the thin passive supervisor and runs N capable workers on the rest (each serves HTTP
_and_ processes); on a single-core box it collapses to one process.

```bash
okdb                       # default: max(1, cores − 1) HTTP workers
okdb --workers 4           # 4 workers
okdb --no-cluster          # single process (back-compat)
OKDB_HTTP_WORKERS=3 okdb   # 3 workers
```

```json
// .kdbconfig
{ "http": { "workers": 4 } }
```

---

## shmbuf requirement (hard gate)

Multi-process clustering is **only safe with the native `shmbuf` binding**. The per-env Hybrid
Logical Clock and changelog clock counter live in a **cross-process shared-memory segment**
(`shmbuf`). Without the native addon, `shmbuf` falls back to an in-process `SharedArrayBuffer`
that cannot coordinate clocks across forked workers — two processes could mint the same HLC /
clock value and corrupt causal ordering.

Therefore, **if `shmbuf` is in fallback mode at startup, the CLI forces `workers:1`** regardless
of any flag, env var, or config, and logs a warning. This gate is non-negotiable.

Check readiness with `okdb doctor`:

```
✓ cluster: ready (7 workers)                                         # native present
✓ cluster: unavailable (shmbuf native missing) — running single-process   # fallback
```

---

## SSE / log coherence boundary

The cluster exposes two distinct event domains. Knowing which is which explains what an SSE
client on a given worker will and won't see:

- **Data changes are cluster-wide.** Each worker runs a **change-feed**: it subscribes to the
  UDP bus `SYSTEM_POKE` signal and, per poke, reads the shared changelog (`getChanges`) to
  reconstruct data-change events (item put/remove, index, view, type). A write committed on
  worker A surfaces in worker B's SSE within the poke window. The bus carries the **signal**;
  the **data** is read from shared LMDB — the changelog is the single source of truth.
- **Processing progress is per-worker; the cluster-wide view is the durable registry.** There is
  no privileged processor — each capable worker processes its own claimed leases and emits its own
  ephemeral processing events (view-rebuild progress, FTS/index lifecycle, processor lifecycle) to
  **its own** SSE. The cluster-wide picture is **read** from the durable `~processes` registry:
  each worker reports its processing facet to the supervisor over **cluster IPC**, the supervisor
  stamps it onto the worker's registry row, and any node serves `/api/processing/status`,
  `/api/processors/status`, and `/api/cluster/status` from that shared registry. So a processing
  event on worker A is not mirrored into worker B's live SSE, but A's processor **state** is
  visible cluster-wide via the registry-sourced status routes.
- **Worker logs are forwarded to the supervisor's log pipeline** over cluster IPC (tagged per
  worker) so the operator log is unified; they are **not** mirrored into other workers' SSE
  streams (SSE log frames are per-process). Only data changes (via the changelog) are coherent
  across every worker's SSE.

`/api/cluster/status` returns the cluster shape (supervisor pid, worker pids, uptime).

---

## Lifecycle

- **Worker death → primary respawns** it with bounded backoff (`min(4000, 250·2^failures)` ms)
  and a crash-loop guard (≥ 5 deaths / 10 s per slot stops respawning that slot).
- **Primary death → workers exit** (no orphan listeners or locks), via `cluster` disconnect plus
  a POSIX `ppid===1` backstop.
- **Shutdown** drains in-flight requests, then closes envs, with a 3000 ms hard-exit backstop.

---

## Embedded clustering

The **library default is single-process** and unchanged. `new OKDB(...).http.listen(port)`
returns a plain single-process `http.Server`.

> **Removed in 2.0:** the embedded `http.listen(port, { workers, makeOkdb, primaryOkdb })` API
> (it **throws `HTTP_CLUSTER_REMOVED`**). A library node never forks — HTTP clustering is a
> **launcher** concern. See [Upgrading to 2.0](upgrade-2.0.md).

Two ways to cluster an embedded app — both are the same **"N identical capable nodes"** shape
(every node serves _and_ processes; the 1-of-N lease distributes the work; no privileged processor):

1. **N independent nodes behind your balancer** (simplest). Run your entry as N separate processes,
   each a full `new OKDB(path).http.listen(port_i)`, and put a load balancer in front. They
   coordinate through the shared LMDB + bus + the lease — no Node `cluster`, no supervisor needed.
2. **Plain Node `cluster`** (one listen port, shared socket). Fork your entry; each worker opens a
   **capable** OKDB and calls `http.listen(port)` — a cluster worker's `listen` shares the socket
   natively, with no okdb involvement.

```js
const cluster = require('node:cluster');

if (cluster.isPrimary) {
    // Thin supervisor: open a passive node BEFORE forking to seed the shared __tokenSecret,
    // then fork N capable workers. It does not serve or process.
    const supervisor = new OKDB(dbPath, { processors: false, compaction: false, http: false });
    await supervisor.open();
    for (let i = 0; i < 4; i++) cluster.fork();
} else {
    // Each worker = an identical CAPABLE node: serves HTTP AND processes (claims leases,
    // pool-drains heavy work off its loop). The lease distributes processing across them.
    const w = new OKDB(dbPath, { processors: true });
    await w.open();
    w.http.listen(port); // shared socket via Node cluster; bus auto-derives from the shared path
}
```

The same shmbuf requirement applies — only cluster on a host with the native `shmbuf` binding.
For a turnkey cluster (supervisor, respawn, registry rows, log forwarding), `bin/okdb` does all of
this for you.
