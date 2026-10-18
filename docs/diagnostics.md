# Diagnostics — finding crashes, hangs, and stalls

okdb's hardest failures are timing races on LMDB's native memory map: a write or read that
touches an env after it was closed/unmapped for a compaction swap or `removeEnvironment`. They
surface as:

- **`The environment is already closed`** — an uncaught JS error thrown from inside lmdb's own
  deferred callback (no okdb stack at throw time). The "crash".
- **`0xC0000005` / access violation** (Windows) / **SIGSEGV** (POSIX) — a native read/write
  after unmap. The "hard crash".
- **A hang / "halt"** — a compaction swap that never completes because something pins the env
  across the swap (a long drain, a wedged commit).

These are rare and timing-dependent, so the fix is **resident, opt-in instrumentation** you can
turn on in the failing deployment and leave on until it fires. Four independent tools, each a
single env var, **none with any meaningful cost when off** — plus always-on status surfaces
(writer and processor status) you can read without enabling anything.

> **Before anything else: are you running current code?** These races have been fixed
> incrementally. okdb ships as a **build** (`dist/` / `release/` / npm package), not `src/`. If
> your deployment's build predates the fix, you are chasing a ghost. Rebuild
> (`npm run build` / `npm run build:release`) and redeploy, then reproduce. Check the build date
> against the relevant commits before spending time on instrumentation.

---

## 1. `OKDB_DIAG` — the write-orphan ring + drain-stall watchdog

The primary tool for the "already closed" orphan and the compaction "halt". JS-level; set it per
process (every process that opens the env installs its own handlers).

| Env var                | Default     | Effect                                                                                                                                                                |
| ---------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OKDB_DIAG=1`          | off         | Enable the write-origin ring, the orphan crash-dump handler, and the drain-stall watchdog.                                                                            |
| `OKDB_DIAG_STACK=1`    | off         | Capture a JS stack **at each write**, so a dump names the exact call site (doc commit / cursor save / view-fts-tm replay). A few µs/write — fine for a debugging run. |
| `OKDB_DIAG_DIR=<path>` | stderr only | Also append every dump to `<path>/okdb-diag.<pid>.log` (survives the crash).                                                                                          |
| `OKDB_DIAG_RING=N`     | 256         | Size of the recent-writes ring.                                                                                                                                       |
| `OKDB_DIAG_STALL_MS=N` | 8000        | A **swap** drain held longer than this is dumped as a stall (re-dumped every `N` ms while it persists).                                                               |
| `OKDB_DIAG_WATCH_MS=N` | 2000        | Stall-watchdog poll interval.                                                                                                                                         |
| `OKDB_DIAG_SURVIVE=1`  | off         | After dumping an orphan, **do not exit** — ride through it (the orphaned write is lost, but the process keeps running). Use to gather more than one dump per run.     |

**On an orphan** (`already closed` / invalid-read-txn signature) you get the recent write
origins, newest first — the orphaning call site is named (with `OKDB_DIAG_STACK=1`):

```
=== OKDB_DIAG ORPHAN (env-closed write) @ ... pid=19932 ===
error: Error: The environment is already closed
recent writes (newest first):
  #4821 -3ms env=default raw-put
      at OKDBProcessor._saveCursor (.../okdb-processor.js:...)
      ...
  #4820 -4ms env=default commit
      ...
drain state (envs with a non-zero drain):
  env=default phase=SWAP drainAge=120ms activeWriters=1 writer{depth=1 oldestPendingMs=118 ...}
```

**On a stall** the watchdog dumps _why_ the swap can't finish — the drain phase and age, the
cross-process active-writer count, and this process's writer queue for every draining env:

```
=== OKDB_DIAG STALL: swap drain held 8400ms on env=default @ ... pid=19932 ===
  env=default phase=SWAP drainAge=8400ms activeWriters=1 writer{depth=1 oldestPendingMs=8390 parkedNow=0}
```

`activeWriters > 0` with `depth=0` here means the pinning writer is in **another** process — run
the same dump there.

**Live, no crash needed:** `db.diag()` / `env.diag()` return the same snapshot
(`{recentWrites, drain, ...}`) for an ad-hoc tap or an admin endpoint.

---

## 2. `OKDB_FATAL_REPORT` — native fault report

For the **native** crash (`0xC0000005` / SIGSEGV) that `OKDB_DIAG` can't catch (it's not a JS
exception). Makes Node write a diagnostic report naming the **faulting thread's** JS + native
stack, env, and thread id.

| Env var                   | Effect                                                                   |
| ------------------------- | ------------------------------------------------------------------------ |
| `OKDB_FATAL_REPORT=1`     | Write a Node report on a fatal native error.                             |
| `OKDB_REPORT_DIR=<path>`  | Where to write reports (created if missing).                             |
| `OKDB_FATAL_REPORT_ENV=1` | Include env vars in the report (off by default — they may hold secrets). |

---

## 3. `OKDB_NATIVE_OP_LOG` — the unmap timeline

For an **open-vs-close race** on lmdb-js's shared (process-global, refcounted) native env: a
synchronous breadcrumb right before each risky native op that unmaps/remaps memory
(`db.close`, env swap/rename, `removeEnvironment`, residency evict, reopen) **and** the matching
open. Pairs with `OKDB_FATAL_REPORT`: the report gives the faulting stack, this gives the
open/close timeline (lmdb's native committer runs on its own thread).

| Env var                     | Effect                                                            |
| --------------------------- | ----------------------------------------------------------------- |
| `OKDB_NATIVE_OP_LOG=<path>` | Append a one-line breadcrumb per risky native op.                 |
| `OKDB_NATIVE_OP_STACK=1`    | Also append the JS stack of each op (names the exact close path). |

---

## 4. `OKDB_LOOP_LAG` — event-loop stutter attribution

All derived work (processor drains, FTS indexing, views, time machine, embeddings, the SSE
change-feed) runs on the owner process's event loop in bounded quanta. When a process "lags every
few seconds", this names **who** held the loop: it reports the libuv loop delay and attributes
synchronous wall-time to named subsystems. Lines go through the okdb logger (`feature: 'loop-lag'`).

| Env var                  | Default | Effect                                                        |
| ------------------------ | ------- | ------------------------------------------------------------- |
| `OKDB_LOOP_LAG=1`        | off     | Enable the monitor (per process).                             |
| `OKDB_LOOP_LAG_MS=N`     | 2000    | Report window.                                                |
| `OKDB_LOOP_LAG_MIN_MS=N` | 100     | Print a window only when the loop blocked at least this long. |
| `OKDB_LOOP_LAG_ALL=1`    | off     | Print every window, idle or not.                              |

---

## Always-on status: writer queue, stalls, processors

These need no env var — read them when something is slow or stuck.

- **Writer status** — `env.writerStatus()` returns this process's write funnel for the env:
  `{ depth, oldestPendingMs, committed, commitsPerSec, commitP99Ms, parkedNow, parkedTotal,
highWater }`. **`oldestPendingMs` is THE stall signal**: a small `depth` with a multi-second
  oldest age means commits are stuck, not merely busy. `parkedNow > 0` means writers are blocked at
  the in-flight cap (`OKDB_WRITER_HIGH_WATER`, default 1024) — the committer can't keep up.
  `GET /api/processors/status` includes the per-env `writers` map (all envs, including `~` ones).
- **Writer-stall watchdog** — on by default in processes with `processors` or `engines` on. A commit
  pending with no forward progress for `OKDB_WRITER_STALL_DUMP_MS` (default 10000) is logged loudly
  with the in-flight ages; with `OKDB_WRITER_STALL_EXIT=1`, a wedge older than `OKDB_WRITER_STALL_MS`
  (default 120000) triggers a controlled exit so your supervisor restarts the process.
- **Processor status** — `GET /api/processors/status` (in-process: `env.processor.list()` or a
  registration's `stop.status()`) lists every processor with `state`, `lastClock`, `lag`, `heldBy`, `error`. `lag` is
  computed from the **durable** cursor, so any process reports the lease holder's real progress.
- **`db.pressure()`** — one composite load read (writer stall/depth, max durable processor lag,
  queue backlog, loop lag → `score`), cached 250 ms, for admission policies and autoscalers.

---

## Triage workflow

1. **Confirm the build is current** (see the note above). Most "still crashing after a fix"
   reports are a stale build.
2. Reproduce with the three crash tools on:
   `OKDB_DIAG=1 OKDB_DIAG_STACK=1 OKDB_FATAL_REPORT=1 OKDB_NATIVE_OP_LOG=ops.log OKDB_NATIVE_OP_STACK=1 OKDB_DIAG_DIR=diag/ OKDB_REPORT_DIR=reports/`
3. On a crash:
    - `already closed` → `OKDB_DIAG` dump names the write site. The fix is to route that write
      through `OKDBWriter` with a **synchronous** `putSync`/`removeSync` inside the txn (an async
      `db.put` inside a writer `childTransaction` escapes into lmdb's deferred event-turn-batch and
      orphans on close).
    - `0xC0000005` → cross-reference the `OKDB_FATAL_REPORT` faulting stack with the
      `OKDB_NATIVE_OP_LOG` timeline to find the close that raced the read/write.
4. On a hang: the `OKDB_DIAG` **stall** dump shows which process's writer pins the swap; the
   writer-stall watchdog and `writerStatus().oldestPendingMs` show whether a commit is wedged.
5. On a slowdown with no crash: `OKDB_LOOP_LAG=1` on the suspect process, plus processor `lag`
   and writer `parkedNow` from `/api/processors/status`.
