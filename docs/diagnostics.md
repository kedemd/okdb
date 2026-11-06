# Diagnostics — finding hangs, stalls, and slowdowns

okdb's derived work (processor drains, FTS indexing, views, time machine, embeddings) runs in
bounded quanta next to your writes, and every write goes through one commit funnel per env. When
something is slow or stuck, the questions are: is a commit wedged, is a processor lagging, or is
the process's event loop held?

This page lists what 3.0 gives you to answer them: always-on status surfaces you can read without
enabling anything, plus a few opt-in environment variables that cost next to nothing when off.

> **Before anything else: are you running current code?** Check the installed version
> (`okdb version`) against the changelog before spending time on instrumentation.

---

## Always-on status: writer queue, stalls, processors

These need no env var — read them when something is slow or stuck.

- **Writer status** — `env.writerStatus()` returns this process's write funnel for the env:
  `{ depth, oldestPendingMs, committed, commitsPerSec, commitP99Ms, parkedNow, highWater, ... }`.
  **`oldestPendingMs` is THE stall signal**: a small `depth` with a multi-second oldest age means
  commits are stuck, not merely busy. `parkedNow > 0` means writers are blocked at the in-flight
  cap (`OKDB_WRITER_HIGH_WATER`, default 1024; `0` turns parking off) — the committer can't keep up.
  `GET /api/processors/status` includes the per-env `writers` map (all envs, including `~` ones).
- **Writer-stall watchdog** — on by default in processes with `processors` or `engines` on. A commit
  pending with no forward progress for `OKDB_WRITER_STALL_DUMP_MS` (default 10000) is logged loudly
  with the in-flight ages; with `OKDB_WRITER_STALL_EXIT=1`, a wedge older than `OKDB_WRITER_STALL_MS`
  (default 120000; `0` disables the watchdog) triggers a controlled exit so your supervisor restarts
  the process.
- **Processor status** — `GET /api/processors/status` (in-process: `env.processor.list()` or a
  registration's `stop.status()`) lists every processor with `state`, `lastClock`, `lag`, `heldBy`,
  `error`. `lag` is computed from the **durable** cursor, so any process reports the lease holder's
  real progress.
- **`db.pressure()`** — one composite load read (writer stall/depth, max durable processor lag,
  queue backlog, loop lag → `score`), cached 250 ms, for admission policies and autoscalers.

```js
await env.registerType('Note');
await env.put('Note', 'n1', { text: 'hello' });

const w = env.writerStatus();
console.log(w.depth, w.oldestPendingMs, w.parkedNow);
console.log(db.pressure().score); // < 1 = healthy
```

---

## `OKDB_DIAG` — the recent-writes ring

| Env var            | Default | Effect                                              |
| ------------------ | ------- | --------------------------------------------------- |
| `OKDB_DIAG=1`      | off     | Record every write's origin (env + kind) in a ring. |
| `OKDB_DIAG_RING=N` | 256     | Size of the ring (minimum 16).                      |

`db.diag()` / `env.diag()` return the snapshot: `{ enabled, recentWrites, drain }` —
the newest writes first, and any env with a non-zero compaction drain (its `drainTs` and
cross-process `activeWriters`). With `OKDB_DIAG` unset it returns `{ enabled: false, hint }`.

```js
const d = db.diag();
if (!d.enabled) console.log(d.hint);
else console.log(d.recentWrites, d.drain);
```

---

## `OKDB_LOOP_LAG` — event-loop stutter

When a process "lags every few seconds", this reports the Node event-loop delay per window and
attributes synchronous time to named subsystems. Lines go through the okdb logger
(`feature: 'loop-lag'`).

| Env var                  | Default | Effect                                                        |
| ------------------------ | ------- | ------------------------------------------------------------- |
| `OKDB_LOOP_LAG=1`        | off     | Enable the monitor (per process).                             |
| `OKDB_LOOP_LAG_MS=N`     | 2000    | Report window.                                                |
| `OKDB_LOOP_LAG_MIN_MS=N` | 100     | Print a window only when the loop blocked at least this long. |
| `OKDB_LOOP_LAG_ALL=1`    | off     | Print every window, idle or not.                              |

---

## Triage workflow

1. **Confirm the version is current** (see the note above).
2. **On a hang:** `writerStatus().oldestPendingMs` and the writer-stall watchdog's log show whether
   a commit is wedged; `db.diag()` (with `OKDB_DIAG=1`) shows the last writes and whether a
   compaction drain is waiting on writers in another process (`activeWriters > 0` while this
   process's `depth` is 0 means the pinning writer is elsewhere — check that process).
3. **On a slowdown with no hang:** `OKDB_LOOP_LAG=1` on the suspect process, plus processor `lag`
   and writer `parkedNow` from `/api/processors/status`.
4. **Logs:** raise the console level to `debug` for the run (`OKDB_LOG_LEVEL=debug`, or
   `okdb --log-level debug`) — see [Logging](./logging.md).
