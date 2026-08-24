# Process Registry

The process registry is a root-wide **task manager** for every okdb process sharing one data
directory: the HTTP-cluster primary and its workers, queue/function child processes, a standalone
CLI server, and opted-in embedded nodes. It gives the admin UI (System → **Processes**) and the HTTP API
a single, live view of the whole process tree — and a durable, safe way to control it (pause/resume,
decommission, retry/reset, hard-kill).

It generalizes the same **durable-state-as-coordination** model used by live subscriptions: the
authority for every action is a durable record; the UDP bus only carries a lossy "go re-read it now"
hint. A forged or dropped bus packet can therefore neither trigger nor lose a control action.

> **Opt-in.** The registry is off by default so embedders and tests are unaffected. `bin/okdb` and the
> HTTP cluster turn it on automatically; a library embedder opts in with `new OKDB(path, { processes: … })`.

---

## The model

### A process is a `node`; processors are a facet

The primary entity is the **process**, not the processor. Each long-lived process publishes one
`node` row:

```js
{
  nodeKey,            // identity: `${pid}:${startedAt}` (wall-clock startedAt — same-host, see Liveness)
  kind,               // primary | http-server | queue-worker | fn-runner | cli | standalone | embedded
  pid, ppid, host,
  supervisorKey,      // nodeKey of the supervising process (null = a root) → builds the tree
  slot, slotKey,      // supervised position; slotKey is the STABLE durable control key (see below)
  role,               // { engines, processors, compaction, http } — booleans
  listenAddr,
  caps,               // { controllable, decommissionable, killable, killConfirm? } — see Capabilities
  lifecycle,          // { state: 'running' | 'decommissioning', desiredVersionApplied }
  processing,         // FACET (participants only): { participate, processors[] }
  heartbeatAt, expiresAt,
}
```

A processor (FTS, views, materializer, time-machine, …) is **not** a separate entity — it is summarized
on the owner's `processing` facet (`processing.processors[]`). There are no worker pools in 2.0 —
drains run on the claiming node's loop, so there is nothing pool-shaped to give its own row.

### Two stores, split by lifetime

| Store                     | Where                                               | Lifetime / durability                                   | Holds                                               |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| **Status** (`~processes`) | a dedicated env (`sync:false`, `durability:'fast'`) | **disposable** — crash-loss _is_ the liveness mechanism | one self-refreshed `node` row per live process      |
| **Desired** (`~system`)   | `~processes:desired/*`, `~processes:cmd/*` sub-DBs  | **durable** — the authority for every control action    | pause/decommission/kill intent + retry/reset epochs |

`~processes` is off the change-feed (the `~` env name) and is read by key/range, never tailed. Status
writes emit **no** signal — the panel polls. Only desired-state/command writes emit a `PROC` hint.

### Supervisor-published registration

Children (http-servers, queue/fn runners) lack a stable cross-restart identity and some run with the
bus off, so they do **not** self-register. Their **supervisor** — which already tracks each child's
pid/slot and heartbeats it — writes the child's `node` row (`publishChildRow`) and removes it on exit.
Roots (primary/cli/standalone) and opted-in embedded nodes self-publish via their heartbeat.

### Liveness — wall-clock, read-time staleness

Each writer refreshes its rows every `OKDB_WORKERS_HEARTBEAT_MS` (default 10000); a row's
`expiresAt = now + 3×heartbeat`. Readers drop any row whose `expiresAt` is in the past
(`listNodes` filters at read time) — so a crashed publisher simply ages out; nothing has to notice the
death. Liveness deliberately uses **wall-clock `Date.now()`**, not the HLC: it is a same-host TTL
deadline, not a causal stamp, and there is no clock skew between processes on one host.

### `PROC` — a reconcile hint, never a command

A control write emits `BUS_EVENTS.PROC` = `{ kind: 'reconcile', scope, key }` on the UDP bus. The bus
framing is a shared-secret prefix, **not** an authenticated MAC, so the payload carries no command and
no authority — only "re-read the durable `~system` record for `scope`/`key` now." The owner applies the
durable record on the hint (fast path) **and** on its heartbeat (backstop), so a dropped hint
self-heals within one beat.

---

## HTTP API

All routes require `system:read` (views) or `system:write` (control).

> **Naming.** The canonical surface is **`processes`** — `okdb.processes` and
> `GET /api/processes[/tree]`. `/api/processes*` is the route surface (the former `okdb.fleet` accessor alias was removed). The tables
> below still use `/api/processes*`; `/api/processes*` is equivalent for the read views.

| Method & path                                        | Purpose                                                        |
| ---------------------------------------------------- | -------------------------------------------------------------- |
| `GET /api/processes` (or `/api/processes`)           | flat list of live processes (grouped, each with `instances[]`) |
| `GET /api/processes/tree` (or `/api/processes/tree`) | nested process → instance → work tree (`supervisorKey`)        |
| `POST /api/processors/:id/pause`/`resume`            | durable pause/resume of a processor (desired-state)            |
| `POST /api/processors/:id/retry`                     | retry an errored processor (durable command epoch)             |
| `POST /api/processors/cursor/reset`                  | reset a processor cursor to 0 (durable + command epoch)        |
| `POST /api/processes/:nodeKey/decommission`          | gracefully stop a supervised process and keep it down          |
| `POST /api/processes/:nodeKey/recommission`          | reverse a decommission/kill — the supervisor re-forks the slot |
| `POST /api/processes/:nodeKey/kill?force=1`          | hard-kill (guarded; see Control tiers)                         |

When the registry is off (single-process / embedders), `/api/processes[/tree]` returns a degenerate
single-root node so the API still answers.

---

## Control tiers

All three tiers write a durable record behind HTTP auth, then emit a `PROC` hint. The owner (or the
target's supervisor) reconciles it.

1. **Soft — pause/resume** (`controllable` kinds). Durable `~processes:desired/{proc,pool}/<key>` with a
   monotonic `version`; the owner applies it when `version > applied`. Rapid toggles converge to the
   last version (no flip-flop); concurrent writes from two nodes are last-writer-wins by `version`.
2. **Imperative — retry/reset** (`~processes:cmd/<logicalKey>`, monotonic `epoch`). The owner re-bootstraps
   the processor via `processor.restart`; `reset` also zeroes the persisted `~proc:state` cursor (so it
   takes effect on the owner's next start even while it is offline). `epoch > applied` guards against
   replay.
3. **Lifecycle — decommission / hard-kill** (routed through the **supervisor**, not by fighting the
   respawn loop):
    - **Decommission** (`decommissionable` kinds): the supervisor marks the slot dead (no respawn) and
      cleanly `disconnect()`s the child to drain in-flight work. Keyed by the **stable** `slotKey`
      (`cluster:<port>/<slot>`), so it **survives a supervisor restart** — a restarted primary reloads
      the dead slots before its fork loop and does not revive them. **Recommission** clears the record
      and re-forks.
    - **Hard-kill** (`POST …/kill`): the last resort, guarded. Requires explicit `?force=1`. Rejected
      for non-killable kinds. Killing a **primary** additionally requires `?confirm=1` because it tears
      down the whole cluster (its workers self-exit on the primary's death). The supervisor `SIGKILL`s
      its own child; a root reads its own durable kill record and self-terminates.

Every decommission / recommission / kill writes a structured **audit** entry to `~log` (feature
`workers`: actor, target `nodeKey`+`kind`, action, result), surfaced in System → Logs.

### Capabilities

`caps` is published per kind and **enforced by the routes**:

| kind                                         | controllable | decommissionable | killable | kill confirm |
| -------------------------------------------- | ------------ | ---------------- | -------- | ------------ |
| `primary`                                    | if owner     | no (root)        | yes      | cluster-wide |
| `cli` / `standalone`                         | if owner     | no (root)        | yes      | confirm      |
| `http-server` / `queue-worker` / `fn-runner` | no           | yes              | yes      | force        |
| `embedded`                                   | no           | no               | **no**   | —            |

Roots have no supervisor to route a decommission through — stop a root via its own shutdown or a
confirmed kill. `embedded` is **observe-only**: okdb must never `process.exit` a host application, so an
embedded node is never killable and never self-terminates.

---

## Scope: same-host processes vs sync peers

The registry covers **same-host, same-root** processes — they share the LMDB files, the UDP bus, and
the `EnvSharedState` shmbuf. **Cross-machine sync-replication peers are a separate axis** (no shared
LMDB; "kill" there would be a sync-protocol RPC) and are surfaced by the Sync view, not the process registry.

---

## Embedding

```js
// Observe-only: appear in the registry, expose nothing controllable.
const db = new OKDB('./data', { processes: { register: true, kind: 'embedded' } });

// A library server that wants the full registry (and is the processor owner):
const db = new OKDB('./data', { processes: { kind: 'standalone', listenAddr: ':8484' } });
```

`register: true` makes a process publish its own row even when it is not a `processors`-role owner.
`bin/okdb` sets `kind` automatically (`primary` / `http-server`); embedders pass it explicitly.

---

## Operational notes

- **Bus secret & kill safety.** The `PROC` hint is only a nudge, so a weak/default bus secret cannot
  forge a control action — the durable `~system` record (written behind HTTP auth) is the sole
  authority. Still, set `OKDB_BUS_SECRET` in production so unrelated processes don't cross-poke.
- **Hard-kill kill-switch.** The irreversible hard-kill tier is enabled by default but can be locked
  down — `OKDB_PROCESS_KILL=off` or `new OKDB(path, { processes: { kill: false } })`. **Recommended in
  production.** When off, every node's `caps.killable` is `false`, so the UI hides the Kill button and
  the route rejects it (409). The graceful, reversible decommission/recommission tier is unaffected.
- **`okdb doctor`** reports a `processes: N (M supervised)` line when a server is already running on the
  data directory (read as a passive reader; skipped otherwise).
- **Heartbeat tuning.** `OKDB_WORKERS_HEARTBEAT_MS` (default 10000) sets the publish cadence and, ×3, the
  liveness TTL. Lower it for snappier death detection at the cost of more status writes.

See also: [HTTP Clustering](http-cluster.md), [Processors](processors.md).
