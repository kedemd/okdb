# Upgrading to okdb 2.0

okdb 2.0 is a **breaking redesign of the runtime model**. The document model, storage
formats, HLC, sync wire protocol, and query/index APIs are **unchanged** — your data and
your read/write code keep working as-is. What changed is **how a process declares the work
it does**.

> **The one-sentence shift.** okdb stops being a runtime _orchestrator_ (a managed,
> auto-scaled "worker population") and becomes a _substrate_: **the process is the control
> unit**, it **declares** what it runs (it is never told by a supervisor), the per-`(env,type)`
> lease is the load balancer, and **spawning/placement is the launcher's job** — `bin/okdb`,
> systemd/k8s, or your own code. `new OKDB(path)` is still a correct, do-everything
> single-process node; you only add nodes when you decide you need them.

If you only ever used `new OKDB(path)` and the built-in CLI, **most of this doesn't affect
you** — the zero-config default is unchanged. The breaking surface is concentrated in the
constructor options and a few cluster/worker APIs.

---

## Constructor: now pure policy

The constructor declares **what role a node plays**. Every _mechanism_ that used to be a flag
is now **derived** — okdb turns it on the moment it's needed.

```js
new OKDB(path, {
    processors: true | false, // does this node participate in processing? (claim leases + drain)
    engines: true | false, // embeddings/vector-search this node runs
    compaction: true | false, // eligible to claim the per-env compaction lease
    auth,
    encryptionKey,
});
```

There is no `http` constructor option — the HTTP server exists only when you call
`db.http.listen(port)`.

> **`processors` is a plain boolean.** An earlier 2.0 draft exposed a _filtered_ claim API
> (`processors: '<filter>'`, `db.processors.process()/processRest()/processEverything()`,
> per-node "dedication" + intent/complement). That was **removed** before release — it is one
> boolean: `true` = participate (claim every unclaimed `single` lease, the default), `false` =
> passive (claim nothing). Passing a filter string/array throws. See _Processors: one boolean_ below.

### Removed options — they now **throw** with a migration message

| 1.9 option                             | 2.0                                                                                                                                      | Error                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `asyncProcessors: true`                | `processors: true` (participate — claim every unclaimed lease)                                                                           | _(thrown, with message)_        |
| `asyncProcessors: false`               | `processors: false` (passive — claim nothing)                                                                                            | _(thrown, with message)_        |
| `processors: '<filter>'` (2.0 draft)   | `processors: true \| false` — the filtered claim form was removed before release                                                         | _(thrown, with message)_        |
| `bus: true \| false`                   | **removed** — auto-enabled when the LMDB path is shared and the shmbuf native binding is present                                         | `BUS_OPTION_REMOVED`            |
| `envs: 'all' \| 'core' \| […]`         | **removed** — envs always open lazily; `removeEnvironment` broadcasts a release signal so handles close                                  | `ENVS_REMOVED`                  |
| `sync: false` (per env)                | **removed** — the changelog auto-enables for every user env; a pure local store simply never gets a consumer                             | `SYNC_OPTION_REMOVED`           |
| `processing: 'auto' \| 'main'`         | **removed** — participation is the `processors` boolean (see below)                                                                      | `PROCESSING_REMOVED` _(thrown)_ |
| `processing: 'threads' \| 'processes'` | **removed** — there is no execution placement to configure: all drains run on the owner's loop in bounded quanta (see _Execution_ below) | `PROCESSING_REMOVED` _(thrown)_ |
| `workers: …`                           | **removed** — there is no managed population (see _Workers dissolved_)                                                                   | _(see `db.workers` below)_      |
| `compaction: 'active' \| 'passive'`    | **removed** (pre-release draft alias, never shipped) — `compaction` is boolean-only, like the other role flags                           | `COMPACTION_ALIAS_REMOVED`      |

**Why these are safe to remove:** `bus` is load-bearing but detectable (shared path ⇒ on);
`envs` was never a real boundary (self-trusted embedded code can `openEnv()` anything) — its
only job was a Windows file-deletion race, now fixed by the env-release broadcast; the
changelog only costs anything when something consumes it, so it switches on with the first
consumer (a view, FTS, processor, subscription, or replication peer) — pre-existing writes are
covered by that consumer's normal bootstrap (snapshot scan + replay tail).

---

## Processors: one boolean

A node either **participates** in processing or it doesn't. That's the whole control surface.

```js
new OKDB(path, { processors: true }); // participate: claim every unclaimed `single` lease (default)
new OKDB(path, { processors: false }); // passive: claim nothing (reads/writes + inline still work)
```

- `new OKDB(path)` (no `processors` option) ⇒ **`processors: true`** — a single node claims
  everything, exactly like 1.9's default full-role instance.
- The per-`(env,type)` `OKDBLock` lease is the load balancer: with N participating nodes, each
  `single` processor is claimed by exactly one of them (1-of-N); a dead node's leases lapse and a
  survivor re-claims (failover).
- Under sustained load the lease **load-shares by cooperative hold-window claiming**: a holder
  drains for up to `OKDB_LEASE_HOLD_MS` (200 ms) per window and yields **only if a peer has
  signalled it wants a turn** (a decaying marker in `~lock:want`). A lone process therefore keeps
  its leases and drains at full speed with zero lock churn; when a second process has backlog they
  rotate, splitting the work ≈evenly.
- Coverage is guaranteed while ≥1 participating node is live. A `single` processor that **no**
  live node claims surfaces as **`unclaimed`** in the Processors view (a warning).

`asyncProcessors: true` ≡ `processors: true`; `asyncProcessors: false` ≡ `processors: false`.

> **Removed:** the filtered claim API — `processors: '<filter>'`, `db.processors.process(filter)`,
> `processRest()`, `processEverything()`, and per-node dedication/intent/complement. There is no
> per-type claim filter: every participating node is identical and the lease distributes the work.
> The verbs throw with a migration message; a filter value throws at construction. To **dedicate**
> hardware to processing, invert the flag: run the dedicated node with `processors: true` and open
> every other node `processors: false` — participation is per-node, so the passive nodes serve
> reads/writes while the dedicated one drains everything.

---

## Execution: everything on the owner's loop

There is exactly **one** execution model, and it is the simple one:

- **The event loop** runs reads/writes, sync apply, and every derived-work drain (FTS, views,
  time-machine, materializer, embeddings). A drain never runs monolithically: `_flush` works in
  **FLUSH_QUANTUM-bounded batches** (default 5 000 changes, `OKDB_PROCESSOR_FLUSH_QUANTUM`;
  heavy per-item handlers like FTS use a smaller per-processor quantum), yielding to the loop
  between chunks. The single async **`OKDBWriter`** per env keeps commit fsyncs on lmdb-js's
  native committer thread, so the loop is never blocked on durability.
- **The sandbox** is the one thread in the engine — it runs **untrusted** per-call function code
  only. Its concurrency is capped per process (`OKDB_FN_SANDBOX_CONCURRENCY`).
- There is **no processing pool, no slot threads, no off-loop trusted compute**. This was built
  and measured: okdb's derived work is write-dominated (posting/group read-modify-write + fsync),
  which cannot leave the owner — threads bought ~1.0× at real workloads while adding shared-env
  lifecycle hazards. If one process's loop is not enough, run more processes — the 1-of-N lease
  spreads the processors across them (see _Processors_ above).

**Ephemeral nodes** (CLI one-shots, serverless, short-lived scripts) should pass
`processors: false`: a process that grabs a 1-of-N lease and exits mid-quantum would thrash it.
`bin/okdb`'s one-shot subcommands already open passive.

---

## Workers dissolved — placement is the launcher's job

There is **no managed worker population** in 2.0. A "worker" was only ever a process that
opened the root and claimed processors.

| 1.9                                           | 2.0                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `db.workers.ensure({ scale })`                | **throws `WORKERS_REMOVED`.** Fork your own nodes: `new OKDB(path, { processors: true })`.          |
| `db.workers.destroy()`                        | **throws `WORKERS_REMOVED`.**                                                                       |
| autoscaler / desired-state / supervisor       | gone from the library; survives only as **`bin/okdb`** launcher internals (the reference launcher). |
| `GET /api/workers`, `POST /api/workers/scale` | **410 `WORKERS_REMOVED`.**                                                                          |

**To run a multi-process processing tier:** start more nodes over the same path — a plain
`new OKDB(path, { processors: true })` in a process you launch (pm2, systemd, docker, k8s, or
your own `child_process`). Opening the path _is_ joining — the leases distribute the work across
whatever nodes exist, and the hold-window rotation load-shares under sustained backlog.

okdb still **exposes the scaling signals** (per-processor durable lag, writer queue depth,
loop-lag) on the Processors/Processes admin surfaces so an external orchestrator can decide when
to add or retire nodes — but the _policy_ lives wherever you run the processes, not inside okdb.

---

## HTTP clustering: launcher-level only

A library node **never forks**. The embeddable child-entry clustering API is removed.

| 1.9                                                     | 2.0                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.listen(port, { workers, makeOkdb, primaryOkdb })` | **throws `HTTP_CLUSTER_REMOVED`.**                                                                                                                                                                                                                                                                             |
| `bin/okdb` HTTP cluster                                 | **N identical capable nodes** — each forked worker serves HTTP **and** processes (claims leases, drains on its own loop). No privileged processor; the Node-cluster primary is a thin **passive supervisor** (seeds the shared token secret, owns the registry). A dead worker's claims fail over to the rest. |
| embedder wants socket-sharing                           | use plain Node `cluster` yourself — a cluster worker calling `http.listen(port)` shares the socket natively, no okdb involvement. Or run **N independent `new OKDB(path)` full nodes** behind your balancer (same "N capable nodes" shape; they coordinate via the shared LMDB + bus + the 1-of-N lease).      |

`http.listen(port)` (single-process) is **unchanged** and still returns a plain `http.Server`.

---

## Queue & functions

**Queue.** The queue is a **substrate okdb coordinates but does not place** — handlers are trusted
user code of unknown nature. Single-execution and at-least-once come from the CAS claim on the
durable job row, not from any pool. One verb:

- `queue.process(type, closure)` — an in-process consumer on **this** loop.

Scale by running more independent consumer processes (pm2, systemd, docker, kubernetes). Each opens
okdb and calls `process()` — the durable CAS claim hands each job to exactly one consumer without
coordination. The canonical pattern is a `workers/default.js` standalone script (see docs/queue.md).

`queue.worker(type, module)` — the auto-adopted "shared pool" form — was **removed** (throws
`QUEUE_WORKER_REMOVED`). `queue.spawn(type, module)` — the dedicated forked child — was also
**removed** in 2.0. Run independent consumer processes instead; they claim the same durable jobs
exactly once via CAS. The orphan-lock hazard (a forked okdb child that outlives its parent holds
the LMDB lock) is avoided by using independent processes instead of `child_process.fork`.

**Functions.** A function runs on **the node it was asked on**, in that node's per-process
sandbox thread — no `~fn:requests` round-trip for synchronous calls. Durable / run-eventually
functions become a queue job on a designated node. `OKDB_FN_LEGACY_POOL` and the fork-pool
path are gone.

---

## Processor handlers: named-registry vocab

okdb 2.0 adopts the **named-registry vocab** for processor handlers (PV-04). The document
model, storage formats, HLC, sync wire protocol, query/index, and view APIs are **unchanged**.

### Breaking: closure handlers rejected without a quantum or durable definition

Bare closures passed as `handler` to `processor.register()` are no longer accepted for
`single`/`fanout` processors. Replace them with one of:

- **Named handler** (built-in, resolved at runtime):

    ```js
    // Register once at feature-load time:
    OKDBProcessor.registerHandler('my:handler', async (ctx, changes, info) => { ... });

    // Then register the processor:
    env.processor.register('MyType', { handler: 'my:handler', mode: 'async', distribution: 'single', cursorKey: 'my:key' });
    ```

- **Module reference** (external file, resolved via `require`):
    ```js
    env.processor.register('MyType', {
        module: { path: require.resolve('./my-handler.js'), export: 'apply' },
        mode: 'async',
        distribution: 'single',
        cursorKey: 'my:key',
    });
    ```

Internal processors that need a closure snapshot-handler must pair it with a `quantum`
(the reconstructible drain module — FTS, time-machine, materializer use this form) or declare
`definition: { durable: true }` for inline processors.

### New: handler identity in status output

`processor.status()`, `GET /api/processors`, and `GET /api/processors/status` now include:

- `handler`: the registered handler name (`'my:handler'`), or `null`
- `module`: the module spec (`{ path, export }`), or `null`

These fields are also persisted to `~proc:state` as `<cursorKey>:handlerMeta` so the
handler identity is durable across restarts.

### Stored-meta migration

On open, FTS type meta (`typesDb`) and procmode desired-state records are automatically
migrated: `runIn` is dropped, and old mode tokens (`worker`→`single`, `async`→`fanout`)
are normalized. This migration is idempotent and runs at most once per env.

---

## Compaction, replication, engines — claimed responsibilities

Three things that were "a role flag standing in for a cross-process lock" are now explicit
**claims on the existing flat `OKDBLock`** — which fixes real latent bugs:

- **Compaction** is a per-env lease. Concurrent compaction is now impossible by construction
  (1.9 had _no_ lock — two `active` nodes could race the `data.mdb` swap). `compaction: true`
  means "eligible to claim," not "the sole compactor by fiat." A **two-phase drain** shrinks
  reader unavailability from the whole compaction to just the file swap.
- **Replication** is a `replicate:<peer>` claim — one local owner per remote peer, with
  **lease failover** (1.9 had none; if the syncing process died, replication stopped). The peer
  set stays a durable definition; `sync` never returns as a constructor flag.
- **Engines** (`vector-search`) fold into the same filter/claim model: a node loads only the
  engines it's placed to run, lazy-loads the HNSW on first query, and evicts when idle (fixing
  the eager-load memory bomb). `embeddings.search()` is **location-transparent** — it resolves
  the index holder and proxies the query over internal HTTP, so search works on any node. The
  `affinity`-tag placement mechanism is deleted.

---

## Persisted records — one open-time shim (automatic)

On the first 2.0 `open()`, an idempotent shim reconciles old records. You do nothing.

| Record                                  | 2.0 action                                 |
| --------------------------------------- | ------------------------------------------ |
| desired-state scope `'workers'` (scale) | obsolete — ignored + deleted               |
| scope `'queue-worker'` definitions      | obsolete — auto-adoption removed; inert    |
| scope `'procmode'` records              | kept — already canonical `single`/`fanout` |
| `~engines` records: `affinity` field    | stripped/ignored — placement is claims now |
| `~engines` records: definition fields   | kept — the durable engine config           |
| scope `'node'` registry rows            | kept                                       |

---

## Quick checklist

1. Remove `asyncProcessors`, `bus`, `envs`, `sync`, `processing`, `workers` from your
   constructor calls. Map `asyncProcessors:true/false` → `processors:true/false`.
2. Replace any filtered claim (`processors:'<filter>'`, `db.processors.process()/processRest()/
processEverything()`) with the boolean `processors: true|false`. Place a processor type by
   running a node where you want it — claiming is first-come on the lease, not configured.
3. Replace `queue.worker(type, module)` or `queue.spawn(type, module)` with `queue.process(type, fn)`
   (in-loop), or run a consumer on another independent process/node.
4. Replace `db.workers.ensure({scale})` with launching extra `new OKDB(path, { processors: true })`
   nodes (or let `bin/okdb` do it). Use `processors: false` for short-lived/ephemeral processes.
5. Replace any `http.listen(port, { workers })` with `bin/okdb` clustering or plain Node `cluster`.
6. Drop `sync: false` on environments — a pure local store simply never attaches a consumer.
7. If you scraped `/api/workers`, read the registry-sourced `/api/processes/tree` +
   `/api/processors/status` instead.
