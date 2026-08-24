# Diagnostics — finding crashes, hangs, and stalls

okdb's hardest failures are timing races on LMDB's native memory map: a write or read that
touches an env after it was closed/unmapped for a compaction swap or `removeEnvironment`. They
surface as:

- **`The environment is already closed`** — an uncaught JS error thrown from inside lmdb's own
  deferred callback (no okdb stack at throw time). The "crash".
- **`0xC0000005` / access violation** (Windows) / **SIGSEGV** (POSIX) — a native read/write
  after unmap. The "hard crash".
- **A hang / "halt"** — a compaction swap that never completes because something pins the env
  across the swap (a busy slot, a wedged commit).

These are rare and timing-dependent, so the fix is **resident, opt-in instrumentation** you can
turn on in the failing deployment and leave on until it fires. Three independent tools, each a
single env var. **None has any cost when off.**

> **Before anything else: are you running current code?** These races have been fixed
> incrementally. okdb ships as a **build** (`dist/` / `release/` / npm package), not `src/`. If
> your deployment's build predates the fix, you are chasing a ghost. Rebuild
> (`npm run build` / `npm run build:release`) and redeploy, then reproduce. Check the build date
> against the relevant commits before spending time on instrumentation.

---

## 1. `OKDB_DIAG` — the write-orphan ring + drain-stall watchdog

The primary tool for the "already closed" orphan and the compaction "halt". JS-level, works on
the main process **and** slot/worker isolates.

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

**On a stall** the watchdog dumps _why_ the swap can't finish — which writer is in flight and
which slots are pinning the env:

```
=== OKDB_DIAG STALL: swap drain held 8400ms on env=default @ ... ===
  env=default phase=SWAP drainAge=8400ms activeWriters=0 writer{depth=0 oldestPendingMs=0 parkedNow=0}
    slots PINNING this env: #3/fts/fts:default:Order
```

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
(`db.close`, env swap/rename, `removeEnvironment`, residency evict, reopen, slot stop) **and**
the matching open. Pairs with `OKDB_FATAL_REPORT`: the report gives the faulting stack, this
gives the cross-thread open/close timeline.

| Env var                     | Effect                                                            |
| --------------------------- | ----------------------------------------------------------------- |
| `OKDB_NATIVE_OP_LOG=<path>` | Append a one-line breadcrumb per risky native op.                 |
| `OKDB_NATIVE_OP_STACK=1`    | Also append the JS stack of each op (names the exact close path). |

---

## Triage workflow

1. **Confirm the build is current** (see the note above). Most "still crashing after a fix"
   reports are a stale build.
2. Reproduce with **all three** on:
   `OKDB_DIAG=1 OKDB_DIAG_STACK=1 OKDB_FATAL_REPORT=1 OKDB_NATIVE_OP_LOG=ops.log OKDB_NATIVE_OP_STACK=1 OKDB_DIAG_DIR=diag/ OKDB_REPORT_DIR=reports/`
3. On a crash:
    - `already closed` → `OKDB_DIAG` dump names the write site. The fix is to route that write
      through `OKDBWriter` with a **synchronous** `putSync`/`removeSync` inside the txn (an async
      `db.put` inside a writer `childTransaction` escapes into lmdb's deferred event-turn-batch and
      orphans on close).
    - `0xC0000005` → cross-reference the `OKDB_FATAL_REPORT` faulting stack with the
      `OKDB_NATIVE_OP_LOG` timeline to find the close that raced the read/write.
4. On a hang: the `OKDB_DIAG` **stall** dump names the writer/slot pinning the swap.
5. For a deterministic local repro, `OKDB_SLOTS_INLINE=1` runs slot quanta inline on the owner
   loop — it makes several of these races reproduce 100% instead of intermittently.
