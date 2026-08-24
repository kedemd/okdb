# Processors (custom change-driven workers)

A **processor** maintains derived state from a source type's change log. You register one per type you want to react to; the framework owns the hard parts:

- a **lease** so exactly one process runs each processor (others wait and take over on failure),
- a durable **cursor** so it resumes where it left off after a restart,
- **batching**, post-commit **scheduling** (+ cross-process wake-up over the bus),
- **pause/resume**, and **error recovery**.

OKDB's own features (indexes, views, FTS, materializer, embeddings, time-machine) are built on this primitive — and it's a public extension point you can use directly.

> **What vs. where.** This doc defines _what_ a processor is and its **modes** (the
> guarantee). _Whether_ a node runs `single` processors is the boolean `processors: true|false`
> (participate vs. passive); the per-`(env,type)` lease distributes the work across whatever
> participating nodes share the root (1-of-N, with failover). There is no filtered claim API and
> no managed "worker population" — see [Upgrading to 2.0](upgrade-2.0.md) for the node-model
> placement story.

---

## Modes — the delivery guarantee

A mode names the **delivery guarantee**: how many instances run the handler. All drains run on the owner process's **event loop**, chunked into cooperative quanta (`FLUSH_QUANTUM`-bounded batches with a yield between them) so a large drain never blocks the loop monolithically. There is no execution placement to configure — no thread pool, no `runIn`; the only thread in the engine is the **sandbox** that runs untrusted user-function code. Handlers register per process: pass `handler:'<name>'` (named registry), `module:{path,export}`, or — for internal features — a closure paired with a reconstructible `quantum`.

| mode     | cardinality                         | cursor                      | use when                                                                                       |
| -------- | ----------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `inline` | every writer, inside commit         | —                           | derived state must be consistent the instant the write returns, and the work is cheap          |
| `single` | exactly one claimant topology-wide  | durable (at-least-once)     | background derived work drained on the loop; the lease makes it 1-of-N across processes        |
| `fanout` | every registered instance, own loop | ephemeral (resume-from-now) | N-of-N consumers: each instance runs its own copy, effects must be process-local or convergent |

> **Deprecated aliases.** `single` and `fanout` were previously named `worker` and `async` (released in 1.8.x). The old names still work as **deprecated aliases** — `register()`/`setMode()` accept them and map to the canonical names, warning once per process. `stop.status().mode` always reports the canonical `single`/`fanout`/`inline`.

**Cardinality contracts:**

- `single` (1-of-N): a cluster-wide lease ensures exactly one process drains the log at a time. Others wait and take over if the holder dies. Use for derived state that must have a single authoritative writer. The drain runs on the holder's main loop, chunked; the cursor advances only on a successful drain (at-least-once → write idempotent handlers).
- `fanout` (N-of-N): no lease; every registered instance runs independently from its own in-memory cursor (seeded to "now" at registration — no history replay on restart). Use for process-local derived state, or idempotent/convergent effects. `bootstrap` is always `'none'` — fanout processors do not run snapshot bootstraps.
- `inline` (every writer): runs synchronously inside the commit. **M3 closure advisory**: a plain-closure inline handler is fine for a single writer process, but with multiple writer processes (HTTP cluster workers, fn runners, workers) other instances' writes silently bypass it — `register()` warns once. Declare `definition: { durable: true }` (your code reconstructs the handler on every instance at open — the views/indexes pattern) to silence it. `setMode(…, 'inline')` — which actively creates the multi-writer hazard — hard-rejects plain closures (`PROC_INLINE_REQUIRES_DURABLE_DEFINITION`).

---

## Registering a processor

```javascript
const stop = env.processor.register('Order', {
    mode: 'fanout',
    name: 'order-stats', // shown in admin / status
    cursorKey: 'order-stats', // durable resume key — unique per processor
    originMode: 'all', // 'self' | 'remote' | 'all'
    handler: async (changes, info) => {
        for (const c of changes) {
            // c.type, c.key, c.action ('put' | 'remove'), c.clock, c.value?
        }
    },
});

// Control surface:
await stop(); // unregister + release the lease
stop.status(); // live status { state, lastClock, lag, mode, ... }
stop.pause();
stop.resume();
```

The `handler` is always a **closure** (a function). The portable `handler: {module, export}` form — which ran on a worker thread — was removed alongside the worker-thread executor; passing it now throws. Move shared handler logic into a module your closure calls (`const apply = require('./my-handler'); handler: (changes, info) => apply(changes, info)`) if you want to reuse it across registrations.

`changes` are change-log records (`{ type, key, action, clock, ... }`). With the default `hydrateValues: true`, `put` records also carry `.value` (the current document); otherwise read the document via `info.env.get(c.type, c.key)`.

`originMode` filters by who wrote the change: `self` (this instance's writes only), `remote` (other instances/processes), or `all`.

**`rebuild` (snapshot-bootstrap processors).** With `bootstrap: 'snapshot'` you may pass `rebuild: async () => { ... }` — a feature-owned **full rebuild** (scan the actual docs, then reposition the cursor via `setCursor` + `markSnapshotComplete`). It runs whenever the processor bootstraps with an **un-positioned cursor**: after a cursor reset (the admin ⟲ "full reprocess"), or when a build handoff was interrupted by a crash. Without it, the framework's only option is replaying the changelog from 0 — which is **not** a rebuild: sync-GC prunes the changelog (its horizon ignores processor cursors), so replay-from-0 can silently yield a partial derived store. FTS registers one (re-scans all docs of the type into every index, clearing first).

---

## Snapshot bootstrap and chunked drains

A `single` processor with `bootstrap: 'snapshot'` performs a cooperative snapshot scan, yielding every batch so the event loop stays responsive while a large type is bootstrapped. Live drains run on the loop via chunked `_flush` (a `FLUSH_QUANTUM` bounds each quantum, then yields; heavy per-item features pass a smaller per-processor `flushQuantum`). A feature may supply a reconstructible **`quantum`** module — it re-derives the work for a clock range and commits it durably (optionally advancing the cursor atomically with its output, `selfCursor`) before the cursor moves. This is exactly the path FTS uses — every FTS-indexed type registers a `single`-mode processor (hydrate + tokenize + posting writes) drained on the loop in small bounded quanta.

The cursor only advances on a successful drain, so processing is **at-least-once**; make handlers idempotent. Derived state is eventually-consistent; if you need a deterministic "caught up" point, wait on `stop.status().lastClock` reaching the source clock.

---

## Cross-process behaviour

Each processor takes a lease (the `'proc'` lock). With several processes open on the same env, exactly one runs each `single` processor; the others wait and take over if the holder dies. The lease-holding process drains on its own loop, so there is always a single writer to your derived store.

Under sustained load the lease **load-shares by cooperative hold-window claiming**: the holder drains for up to `OKDB_LEASE_HOLD_MS` (200 ms) per window, and at the window boundary yields the lease **only if a peer has signalled it wants a turn** (`~lock:want`, a decaying marker written by waiting peers with backlog). A lone process therefore keeps its leases with zero lock churn; two loaded processes rotate and split the work ≈evenly. Waiting peers re-contend on a short cadence (~one hold window) while they have backlog and on the slow `ttl/2` failover cadence when idle.

A processor that hits an error **keeps its lease** (in-place `retry()`/`restart()` keeps its slot against standbys in other processes). Re-bootstrap reuses the held lease handle, and `tryAcquire` treats a fresh lease held by the same pid + processorId as a re-acquire — so an errored processor can never deadlock in `waiting` against its own heartbeat.

Cross-process wakes ride the UDP bus (`SYSTEM_POKE`), which is lossy by design. An online holder therefore also runs an **idle catch-up tick** (`OKDB_PROCESSOR_CATCHUP_MS`, default 15 000, `0` disables): every interval it compares each single-mode registration's type head against its cursor and schedules a drain when behind, so a lost poke bounds staleness at one tick instead of "until the next write". The changelog GC in turn **never prunes past the slowest durable processor cursor** — a lagging drain finds its entries intact rather than silently skipping writes.

---

## Cookbook

- **A background derived indexer (like FTS)** — `mode: 'single'`, closure handler, drained on the loop in chunked quanta.
- **An immediate-consistency derived field** — `mode: 'inline'` (cheap work only; it runs on the write path).
- **A light aggregate on the main loop** — `mode: 'fanout'`.

---

## Runtime mode switching (M6)

`env.processor.setMode(logicalKey, mode)` (HTTP: `POST /api/processors/:logicalKey/mode`)
switches a processor's mode at runtime through a durable config record (registry
desired-state scope `'procmode'`) + a clock-boundary handoff:

| transition        | mechanics                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `single → fanout` | holder drains to clock C, releases the lease; every instance seeds its in-memory cursor at C                                                                                 |
| `fanout → single` | instances stop at the flip; durable cursor seeded at max(C, head-at-observance); lease claiming begins                                                                       |
| `* → inline`      | M3 gate re-checked (closures without a durable definition → rejected); gap-fill to head; a per-write version gate makes every writer observe the flip before its next commit |
| `inline → *`      | inline stops on observance; the deferred cursor starts at the observance clock                                                                                               |

Transitions are serialized per processor (a flip while one is unapplied → `PROC_MODE_FLIP_IN_FLIGHT`).
Overlap windows double-run the deferred mode — the (already required) idempotency contract makes
that safe. The per-write gate costs one boolean compare per write when no flip is pending.

---

## Where a processor runs — claiming

The `processors` constructor option is a **boolean** controlling whether **this node**
participates in claiming `single` (1-of-N) processors. It is independent of the mode declared at
`register()`.

| value   | behavior                                                                                    |
| ------- | ------------------------------------------------------------------------------------------- |
| `true`  | **default.** Participate — claim every unclaimed `single` lease this node sees.             |
| `false` | Passive — claim nothing (reads/writes + inline processors still work; another node drains). |

The per-`(env,type)` lease + WAITING-retry is the load balancer — start more participating nodes
over the same path and the work spreads automatically (1-of-N, with failover when a holder dies);
there is no population to configure and no per-node dedication.

> **Removed before 2.0 shipped:** the _filtered_ claim form — `processors: '<filter>'` (throws at
> construction) and `db.processors.process(filter)` / `processRest()` / `processEverything()`
> (throw with a migration message), plus per-node dedication/intent. Also removed: the
> `processing:` option family (`'auto'|'main'|'none'`, `'threads'|'processes'`) — there is no
> execution placement; every drain runs on its claimant's loop in bounded quanta.
> `asyncProcessors: true/false` is now `processors: true/false`. To dedicate hardware to
> processing, run that node `processors:true` and the others `processors:false`. See
> [Upgrading to 2.0](upgrade-2.0.md).
