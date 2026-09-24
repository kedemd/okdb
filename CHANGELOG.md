# Changelog

All notable changes to `@kedem/okdb` are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versions follow [SemVer](https://semver.org/).
Dates are release dates.

## [2.4.0] - 2026-09-25

### Security

- **Sync link scope was not enforced by the node serving the data.** `/api/sync/delta` served
  whatever envs the caller named, ignoring the link's `envs` list and direction — a peer linked
  for env `a` (or linked receive-only) could pull env `b` just by asking, and a `poke` made the
  poked node pull every env from the poker regardless of the link. The delta server now serves a
  signed peer only `~system` plus the data envs the link lets it send to that peer (others are
  omitted and listed in the response's `denied`); the pulling node applies only envs it asked for
  and the link lets it receive, whatever the remote sends (a pre-fix peer can't push past the
  link); a pull without an explicit env list (join, poke, `reconcilePeer`) asks for the link's
  envs only; and a signed `poke` can only trigger a pull from the signer, never a named third
  node. With no link anywhere the cluster stays in legacy full-mesh mode. Note that `~system`
  (the control plane — `~sync_nodes`, `~sync_links`, `~tokens` hashes, `~licenses`, …) still
  replicates with every registered peer: a link scopes data, not trust (see
  [Auth and Sync → What a peer can do](docs/auth-and-sync.md#what-a-peer-can-do)).
- **`system_backup` (HTTP + MCP) could write a full copy of the store to any server path.** It now
  writes only under the backup root — the new `backup.root` option, default `<store>-backups` next
  to the store — rejecting `..`, other absolute paths and symlinks that resolve outside it
  (`400 BACKUP_PATH_OUTSIDE_ROOT`) and existing non-empty directories (`409`). `destDir` is relative
  to the root and optional; the route is marked destructive, so MCP clients must confirm it.
- **Per-env authorization was skipped on the files, queue, FTS and functions routes.** These
  routes declare `access.scope: 'env'` (a string shorthand), but the permission check only read
  `access.scope.env`, so no env was resolved: the protected `~` env gate did not apply (a token
  with global `queue:read` could read `/api/env/~system/queue/...` without `protected:read`), and
  per-env grants were ignored (a token granted `{ orders: ['files:read'] }` got 403 on
  `/api/env/orders/files`). The shorthand now resolves the `:env` path param like
  `scope: { env: 'params.env' }`.
- **Query filters could execute arbitrary code via `$where`.** Filters are compiled by `sift`,
  whose `$where` operator compiles a string with `new Function` and runs it in-process — so any
  caller able to pass a filter (`data:read` over HTTP `…/type/:type/query` and `…/count`, the MCP
  query tool, FTS/vector post-filters, view definitions, subscription filters) could run code on
  the server. Every call site now compiles through one helper (`src/core/okdb-query-filter.js`)
  that allows only declarative operators; `$where` (string or function, at any nesting depth) is
  rejected with `QUERY_OPERATOR_FORBIDDEN` (HTTP 400) and never evaluated. A view stored with
  `$where` before this fix is not activated on open (logged; remove and re-create it), and a
  stored subscription filter using it never matches.

### Changed

- **FTS results are ranked by relevance (Okapi BM25).** Every token match used to score a flat
  weight and AND-mode results came back in docId order, cut at `limit` — so "top 50" meant the
  oldest 50 matches. Search now scores every matching doc with BM25 (k1 = 1.2, b = 0.75: term
  frequency, inverse document frequency, doc-length normalization) and returns the best `limit`
  across **all** matches (bounded top-k; ties break oldest-first). `score` is the BM25 value on
  `ftsQuery`/`searchDocs` rows and `ftsScore` on `query({ fts })` rows; `maxScore` is now the
  query's BM25 upper bound (was `numTerms × 2`). Prefix mode scores an exact word above a
  prefix-only completion. Storage: tf and doc length ride along as marker terms in the existing
  posting lists (no new sub-DBs), index format 4 → 5. **Existing indexes upgrade in place on
  open** (a re-scan that only adds the markers — no clear), so search keeps answering throughout,
  ranked by idf alone until the upgrade finishes; `fts.ready(type)` resolves when it has.
- **Hybrid `query({ fts, vector })`**: row `score` is now the actual fused RRF value (was a
  rank-derived placeholder), and `fts.weight` / `vector.weight` (default 1) scale each signal's
  contribution to the fusion.
- **Bus POKE is throttled per `(env, type)`**: the first change sends immediately and further
  changes within `OKDB_BUS_POKE_WINDOW_MS` (default 10 ms; `0` = unthrottled) collapse into one
  trailing datagram, so a sustained writer no longer sends one datagram per changed document. A
  process that is the only holder of an env delivers pokes in-process with no datagram.
- **Views over small sources bootstrap in place.** A view whose source has fewer than
  `OKDB_VIEWS_BOOTSTRAP_WORKER_MIN_DOCS` documents (default 5000) is bootstrapped on the calling
  thread instead of spawning a bootstrap worker.
- **Timing knobs are overridable by env var** (defaults unchanged, meant for tests):
  `OKDB_COMPACT_CLOSE_GRACE_MS`, `OKDB_COMPACT_DRAIN_TIMEOUT_MS`,
  `OKDB_CLUSTER_RESPAWN_BACKOFF_MS`, `OKDB_FTS_DROP_COMMITTED_TIMEOUT_MS`,
  `OKDB_READER_CHECK_MIN_INTERVAL_MS`, `OKDB_LOG_FLUSH_MS`, `OKDB_ENV_RELEASE_GRACE_MS`.
  `OKDB_QUEUE_RECONCILE_MS` is now taken as given (it had a 2 s floor).

### Fixed

- **Embeddings on synced peers**: the indexer's `start()` now ensures its `doc_status` type, so
  it exists on peers that received the pipeline by sync.
- **FTS filters starved at the default limit.** `ftsQuery(type, name, text, filter)` applied the
  filter AFTER taking the top `limit` (default 50) hits, so a selective filter returned nothing
  unless `limit` was raised; `query({ fts })` over-fetched a fixed 200 candidates with the same
  failure beyond that. The filter (and a `query` index constraint) is now applied while ranking:
  candidates stream best-first until `limit` rows pass or the matches run out. An explicit
  `fts.limit` in `query()` still caps how many FTS candidates are considered.

- **Cron jobs silently stopped recurring.** A permanently failed run (`markJobFail`) and a claim
  timeout with no tries left (reconcile) left a cron job `failed` forever, and a done run wrote
  `done` and rescheduled in a second commit (a crash between the two ended the series) while
  emitting `queue:done` for a job that went straight back to pending. Every terminal path of a cron
  run now re-queues the same row as `pending` at the next cron time (`tries: 0`, the finished run
  recorded in `job.last_run`) in the one write that ends the run, and emits the new
  `queue:rescheduled` event instead of `queue:done`/`queue:failed`. A run's own retries still go
  first; `cancelJob` is the one path that stops a series.
- **A cancelled or timed-out job kept swallowing its idempotency key.** `cancelJob` and reconcile's
  timeout → `failed` didn't release `idempotency_key`, so a later enqueue with that key returned
  the dead job's id and queued nothing. Keys now dedup against live (pending/running) jobs only and
  every terminal state releases them; a terminal row still holding one (written before this fix)
  is released in the same commit as the new job.
- **Orphan payloads from enqueue.** The payload was committed before the job, so a duplicate
  idempotency key or a lost race left payloads with no job (e.g. 6 jobs, 8 payloads). Payload and
  job are now one transaction, and `removeJob` (incl. `done_ttl`/`failed_ttl: 0` retention) deletes
  both in one commit.
- **`queue.list` paging repeated rows and failed with filters.** The next page started at (and
  repeated) the previous page's last row, rows sharing one `when` were mis-paged, and
  `list({ type or status, cursor })` threw "prefix cannot be combined with startIndex/endIndex".
  Cursors are now opaque exclusive strings that page every type/status/sort/direction combination
  with no repeats or gaps (`list({ type, sort: 'priority' })` also works now — it needed a missing
  index). A cursor reused with a different filter, or an old index-key array cursor, throws
  `BAD_PARAM`. **Breaking for callers that built or inspected cursors** — treat them as opaque.
- **Cancelling a job didn't stop its running handler.** `ctx` had no abort signal and the
  auto-heartbeat's cancel detection was dead (`markJobHeartbeat` resolved quietly on a lost claim).
  Handlers now get `ctx.signal` (an `AbortSignal`), aborted on cancel (`JOB_CANCELLED` — at once in
  the cancelling process, at the next heartbeat elsewhere), on a lost claim (`CLAIM_LOST`), or when
  `stop(timeout)` runs out (`WORKER_STOPPING`). Cancellation is cooperative — handlers are never
  killed. `markJobHeartbeat` now rejects on a lost claim (`NOT_FOUND` / `INVALID_STATE` /
  `CLAIM_MISMATCH`). Queue-worker engines pass the signal to the function sandbox
  (`functions.run(name, payload, { signal })`), which cancels the function and contains it if it
  doesn't unwind.
- **`stop(timeout)` could run a job twice.** On timeout it released the claims of handlers still
  running, so another consumer started the same job concurrently. It now aborts their `ctx.signal`
  and keeps the claim (still heartbeated) until each handler settles: then the job is completed
  (resolved) or released to pending without burning a try (threw). A process that exits first
  leaves the claim to reconcile (at-least-once).
- **Changing a pipeline's embedder model mixed vectors from two models in one index.** A patched
  embedder `model` with the same dims was accepted with only a note to rebuild, vectors did not
  record their model, and chunks re-embed only when their text changes — so new and edited docs
  landed in the new model's space next to old vectors, silently degrading search. The indexer now
  records the embedder fingerprint (`{ type, model, dims }`) next to the pipeline's vectors; when
  the configured embedder no longer matches (patched model, `replaceMember`, an indexer re-pointed
  at another embedder, or a change arriving by sync) the pipeline is **stale**: new embeds are held
  (`stats().waiting.reason: 'EMBEDDER_CHANGED'`, never mixed), `stats().vector_space`,
  `embeddings.vectorSpace(name)` and `pipelines.get()` (`stale`, `vector_space`) report it, the
  admin pipeline card shows **needs re-embed**, and search keeps serving the old vectors with
  `meta.stale` + `meta.warning` on the query/nearest endpoints. `rebuild()` ("Re-embed all")
  re-embeds with the new model and clears it; a patch that keeps the fingerprint (new `api_key`,
  `url`, a no-op) changes nothing. Nothing is re-embedded automatically. Also: the query-embedder
  instance a passive node builds from the durable record is now rebuilt when that record's config
  changes (it kept the old model), and the indexer's hash→vector cache is cleared on a model change.

- **A view with a custom `bucket.project` made the whole store fail to re-open.** The projection
  was a function, which persistence silently dropped, so on the next `open()` the stored bucket had
  neither `preset` nor `project` and compiling it threw `Unknown bucket preset: undefined` — and
  `views.rebuild()` of any other view threw too (its bootstrap worker re-opens the store). A custom
  projection is now referenced by **name**: register it process-wide with
  `OKDB.registerBucketProjection(name, fn)` before `open()` and set `bucket.project: '<name>'`,
  which persists and recompiles on reopen, peers and rebuild (and can be created over HTTP).
  `create()` refuses a function with `BUCKET_PROJECT_NOT_PERSISTABLE` and an unregistered name with
  `BUCKET_PROJECT_UNKNOWN`. **Breaking for callers passing a function** — register it and pass its
  name instead.
- **One bad stored view definition no longer fails `open()`.** Generalizing the `$where` guard: any
  stored view whose definition can't be compiled at boot (unregistered custom reducer or projection,
  a pre-fix function-projection bucket, a forbidden operator) is held back with a logged error —
  `views.get()` returns `null`, `views.getMeta()` reports `state: 'error'` with the error code,
  every other view boots and rebuilds normally, and `views.remove()` still works. `views.rebuild()`
  of a held-back view retries the compile and fully re-derives it on success. Existing stores that
  hold a pre-fix projection view open again; that view is held back (`BUCKET_CONFIG_INVALID`) until
  removed and re-created.
- **Custom reducers ignored documents that already existed when the view was created.** The
  bootstrap-worker eligibility check skipped every `$`-prefixed key while looking for custom
  reducer names — which always start with `$` — so the scan ran on a worker thread that had no such
  reducer and silently dropped it: after `create()` the value was `null` and only later writes
  counted. Custom-reducer (and custom-projection) views now bootstrap on the main thread, so
  bootstrap, live writes and `views.rebuild()` agree, including custom sub-reducers inside
  `$group`/`$ref`.
- **Custom reducers across a reopen.** A reducer name nothing resolves used to be dropped silently
  (a typo, or a stored view opened before `registerReducer` ran — the view then never updated that
  reducer again). `create()` now refuses it with `VIEW_UNKNOWN_REDUCER`; the new process-wide
  `OKDB.registerViewReducer(name, { apply })` (before `open()`) keeps such views live from boot;
  a stored view whose reducer is only registered later via `env.views.registerReducer` is held back
  at `open()` and fully re-derived when it is registered, so no write is lost.
- **`registerReducer('$group')` (or `'$ref'`) was accepted and then silently shadowed** by the
  built-in. Every built-in reducer name and `$ref` are now rejected with `VIEW_REDUCER_CONFLICT`.
- **TTL items could outlive their expiry indefinitely in an idle env.** The sweep timer was armed
  only by `setTTL()`/`clearTTL()` and at open — never re-armed after a timer-driven sweep, and
  never armed by a TTL set through the write option (`put(..., { ttl })`, HTTP PUT `ttl`) or a
  type's `defaultTTL` — so, with no further writes, `put(..., { ttl: 200 })` was still readable
  long after it expired. Every path that sets an expiry now arms the single per-env timer when the
  expiry is earlier than its target (no re-arm otherwise), every sweep re-arms it for the next
  expiry (immediately when a `batchSize`-capped sweep leaves due items), and a sweep error retries
  after 1 s. When only unremovable items are due (FK `restrict`), sweeps back off (1 s → 10 s)
  instead of spinning — also on the write path, which previously re-swept on every write. The
  timer stays `unref()`'d and is cleared on close.
- **`db.range(it)` / `env.range(it)` never ended**: they looped until lmdb's `iterate()` returned
  `null`, but it returns `{ value, done }` results, so the generator yielded `{ done: true }`
  forever. It now yields each item and stops at `done`; plain iterables are accepted too.
- **`POST /api[/env/:env]/transaction` rejected a bare-array body** with 400 `VALIDATION_ERROR`
  ("operations is required"), although the handler and the route's own example use one. The route
  now uses `http.bodyMode: 'array'` (implemented in request validation: a bare-array body binds to
  the route's single array input field), so both `{ "operations": [...] }` and `[...]` validate.
- **Queue: `markJobComplete` / `markJobFail` / `markJobProgress` with a `null` claim id acted on
  another worker's claimed job** — the ownership check was skipped. They (and the
  `completeJob`/`failJob` aliases) now throw `CLAIM_REQUIRED` without a claim id, and
  `CLAIM_MISMATCH` for a claim that is not the job's current one.
- **Queue: `updateBucket` skipped its version check** (it passed a bare version where `update`
  expects `{ ifVersion }`), so a concurrent token claim could be overwritten. It now retries
  against a fresh read on a version conflict.
- **Queue: `list({ bucket, tag })` ignored both filters.** `tag` matches any of a job's `tags`,
  `bucket` any of its `buckets[].id` (or the legacy `bucket`); `limit` counts matching jobs.
- **Auth: `verifyPassword` could crash the process** — on a scrypt error it rejected and then fell
  through to `timingSafeEqual` inside the callback (an uncaught exception), and a stored hash of
  the wrong length threw the same way. It now rejects cleanly on a scrypt error and returns
  `false` for a malformed stored hash. `hashPassword` had the same fall-through.
- **Admin log History was dead: `GET /api/system/logs` returned 500** (`getRange: unrecognized
option "0"` — a stale 3-argument call) and loaded every stored log row into memory before
  filtering. It now walks the ts index newest-first (a `[level|node|feature, ts]` index for a
  single-valued filter), examines at most 5 000 rows per call and pages with an opaque
  `next_cursor` (`"<ts>:<key>"`; same-ts rows are neither skipped nor repeated). A sparse filter
  can return a short page with a non-null cursor — keep paging until it is `null`.
- **Export blocked the event loop and ignored backpressure.** `exportToStream` wrote every row in
  one synchronous loop (200k docs: one ≈0.6 s stall, ≈52 MB buffered in the stream). It now reads
  and writes 1 000-row chunks, awaits `drain` when `write()` returns `false` and yields between
  chunks (200k docs: longest stall ≈10–47 ms, ≈0.3 MB buffered). Consistency is documented as it
  is: per chunk (each key at most once), not point-in-time — use `backup()` for a snapshot.
- **`migrate.backup()` dropped data a restored store needed.** Time-machine history
  (`<env>/time-machine/`) is now copied (LMDB native copy, just before its env); an env whose
  directory name differs from its name (`ws:one` → `ws-one`) was copied where the restored
  registry never looked and came back **empty**; `~fts` is still not copied (derived), but a store
  opened without its `~fts` files now rebuilds every READY index from the documents instead of
  serving silently empty search. Blobs are copied after all metadata, without the `tmp/` staging
  dir; `~processes` is skipped; `envNames` always includes `~system`; the destination must be
  new/empty and outside the store (`BACKUP_DEST_NOT_EMPTY`, `BACKUP_DEST_INSIDE_STORE`); an
  `okdb-backup.json` manifest marks a complete backup. New `okdb restore <dir> --path <target>`.
- **Removed / unknown constructor options were silently accepted.** `workers` now throws
  `WORKERS_REMOVED` and a boolean `sync` throws `SYNC_OPTION_REMOVED` (the `sync` settings object
  is unchanged); any other unknown top-level key logs one warning naming it, with a did-you-mean
  for near-misses (`procesors` → `processors`). The `db.workers` error and the inline-processor
  messages now cite documents that exist.
- **Foreign-key `onDelete` silently did nothing when a key or type contained `@`.** The reverse-ref
  index joined `target@targetKey@source@sourceKey@field` into one string and split it back on
  `@`, so an email/URL key mis-parsed: `cascade` left the child behind, `restrict` let the parent
  be deleted (leaving the child dangling), and `set_null` was never applied. Index rows are now
  structured array keys (every component round-trips exactly), and readers never parse a key
  string. The 2.4.0 storage migration `fk-ref-index-structured-keys` drops each env's index and
  re-derives it from the FK schemas + source docs on first open; a leftover old-format row is
  skipped, never misread. Same fix for numeric source keys (previously stringified, so their
  cascade/set_null was skipped too), for the cascade cycle guard (`'a@b'`+`'c'` collided with
  `'a'`+`'b@c'` and skipped a delete), and for dropping type `A` sweeping index rows of type
  `A@x`. Clearing ref violations for key `a` no longer also clears those of key `a@b`. A store
  opened by 2.4.0 is refused by older builds (`STORE_VERSION_NEWER`).
- **A queue job could stay `running` after its handler finished.** Completing or failing a job was
  a single version-checked write, so a concurrent write to the same row by the claimant itself — an
  un-awaited `ctx.markProgress()`, the auto-heartbeat — made it fail with "Version mismatch". The
  worker only logged a warning; the job then sat `running` until its claim expired and was failed
  or run again. Complete, fail and release now re-read and retry while the claim is still ours,
  and give up only when the claim was actually lost.
- **`ctx.heartbeat()` shrank the claim to ~1 s** when the handler had no explicit `ttl`, so
  another process's reconcile could take over a job that was still running. Manual and automatic
  heartbeats now extend by the ttl the job was claimed with.
- **`max_tries: null` (documented as unlimited) was stored as 1.** An explicit `null` on enqueue,
  on a job-type default or as the queue's `default_max_tries` now means unlimited retries.
- **Queue handler results were dropped.** A local handler's return value, or the `result` passed
  to `markJobComplete`, is now stored on the done job as `job.result` (when JSON-serializable and
  ≤ 16 KB; otherwise `null`). A manual `retryJob` clears it.
- **A synced node could skip a storage migration on its own files.** The `~migrations` log in
  `~system` replicated to peers, and startup trusted any row by id — so a node that pulled a row
  from an already-upgraded peer never ran that migration on its own layout. `~migrations` is now
  node-local: left out of sync deltas and refused when a not-yet-fixed peer sends it. For rows
  already replicated into existing stores, a row counts when this store wrote it, or when this
  store's own (never replicated) layout stamp already covers the migration's version — so a
  lagging node migrates, and a node whose own row was overwritten by a peer's does not re-run it.
- **Vector and hybrid `query()` returned nothing from the vector side for chunked pipelines.**
  `env.query(type, filter, { vector })` looked documents up under the raw chunk keys
  (`docKey\tchunkHash`), so vector-only queries returned `[]` and hybrid `{ fts, vector }` quietly
  degraded to FTS-only. Vector hits are now mapped to their source documents — one row per doc,
  best chunk wins, the matched chunk exposed as `chunkHash` + `chunk: { start, end }` — with chunk
  candidates over-fetched so `limit` counts documents. New
  `okdb.embeddings.searchDocs(name, query, { limit })` / `pipeline.api.searchDocs()` is the
  document-level search; `search()` stays chunk-level.
- **`POST …/pipelines/:pipeline/query` returned chunk hits, so `limit: 10` could yield 5 documents.**
  It now returns one row per document; pass `chunks: true` for the raw chunk-level hits.
  `…/nearest` is unchanged.
- **`POST /api/env/:env/type/:type/query` with `options.vector` failed with 500** (the async hybrid
  result was iterated as an array). Rows now also carry `score`/`vectorScore`/`ftsScore` and chunk
  info when present.
- **Several processes starting on a brand-new store could crash natively.** lmdb-js (3.5.x) has a
  bug affecting concurrent opens: an LMDB open that overlaps another process's commit to the same
  env can move the shared transaction id backwards, and later writes then fail with `SIGSEGV` in
  `mdb_cursor_put`, `MDB_PROBLEM`, an LMDB assertion, or a silently lost commit. On a fresh path
  every booting process opens the same system envs while the others make their first writes to
  them, so ≈1% of 6-process fresh boots crashed. `open()` now takes a cross-process **boot lock**
  while the store is being initialised (an env it opens at boot has no data file yet), so those
  boots run one at a time; `close()` joins it only while a peer is initialising. A dead or stale
  holder is taken over, and a waiter that exceeds `OKDB_BOOT_LOCK_TIMEOUT_MS` (default 60 s) logs
  a warning and proceeds unserialised. An established store is not serialised, so opening a
  process alongside a peer that is actively writing — and runtime `createEnvironment()` /
  `removeEnvironment()` — remain exposed until the issue is fixed upstream; staggered starts keep
  that window small (see [Roles & Deployment](docs/deployment.md)).
- **Concurrent opens of a fresh path could also die with `SIGBUS` or hang.** A process attaching
  to a shared-memory segment in the instant between a peer creating it and sizing it mapped a
  0-byte object and crashed on first access; the segment is now sized by whoever attaches first.
  And `open()` could hang forever in "features + processors" when a peer won the race to build an
  index: `indexReady()` waited on a promise only the building process resolves — it now also
  follows the stored index status.
- **Live subscriptions could come up disabled on one of several concurrently booting processes.**
  The process that lost the race to create the `~sub` types logged "already registered" and ran
  with subscriptions off; setup is now race-safe. Subscription routing is also lazy: a process
  does per-change subscription work only while it holds an open subscription connection, and
  sessions are indexed by `[dataEnv, type]` (20k writes with 200 sessions: 8.2 s → 0.4 s CPU).
- **`fts.ready()` waited forever when another process finished the build.** A pending `ready()`
  was only woken by a build end in its own instance; it now also follows the stored index status.
- **Compaction could crash or stall processes running live FTS.** Lock handles kept across a
  compaction's reopen wrote to the closed pre-swap env ("The environment is already closed.",
  uncatchable); a process opening during a peer's compaction crash-looped on `FTS_DRAINING`; a
  processor drain parked on the compaction held up the env close for its whole grace period; and
  the FTS posting + docs compound write parked on the drain while already holding its writer slot
  — a self-deadlock that made every non-forced `compact()` over a live FTS drain defer. All four
  are fixed (drain-quantum writes are released on close and re-run after the reopen). A lone
  process now skips the close grace period, so its `env.compact()` takes ≈0.1–0.25 s instead of
  3–4 s. A write rejected at the compaction gate no longer leaks a writer admission slot.
- **Views could double-count or miss writes made while they bootstrapped.** A delayed `~views`
  poke could activate a second copy of a view while `create()` was still running (every later
  write applied twice, e.g. 3 500 instead of 3 000); the bootstrap scan and its change replay could
  both count a document written during the scan; a write in flight at a sync view's hand-off to
  live processing could be lost; `rebuild()`/`stop()` could race a running scan (12 000 counted for
  10 000 docs); and the view-rebuild lease was never awaited. Activation is now idempotent, the scan
  leaves every document changed after the create-time clock to the replay, and a sync view's final
  replay and its `ready` flip happen in one write, so counts are exact for inserts. Known limitation: a sync view can
  still double-count an _update or delete_ of an already-scanned document during its bootstrap;
  `views.rebuild()` corrects it. An interrupted bootstrap is not resumed — the next `open()`
  rebuilds the view.
- **`close()` during a view bootstrap could hang process exit.** Terminating the bootstrap worker
  in the middle of an LMDB write left lmdb's native write thread waiting forever. The worker is now
  cancelled cooperatively at a batch boundary and closes its own store (`terminate()` only after
  `OKDB_VIEW_WORKER_CANCEL_TIMEOUT_MS`, default 10 s); `create()` resolves after the worker exits,
  and no worker starts into a closing env. The bootstrap's change replay runs in chunks
  (`OKDB_VIEWS_REPLAY_QUANTUM`, default 1 000) and yields, instead of one long loop stall.
- **The change-feed could announce a same-process write without its previous value.** A poke-driven
  drain could reach a change between its commit and the in-process event, emit it without
  `prevValue`, and the richer in-process event was then dropped as a duplicate. The drain now
  leaves such changes to the in-process event.
- **Functions failed to compile under load.** Evaluating a function's source was bounded by a
  hard-coded 100 ms wall clock, so a busy process got spurious `FUNCTION_SCRIPT_COMPILE_FAILED`.
  The bound is now 1 s (`OKDB_FN_COMPILE_TIMEOUT_MS`).
- **`functions.run(name, payload, { timeoutMs })` ignored `timeoutMs`.** It now overrides the
  stored `runtime.timeoutMs` for that call; it must be a positive finite number
  (`FUNCTION_INVALID_TIMEOUT`) and is capped at `OKDB_FN_MAX_TIMEOUT_MS` (default 600 s).
- **Materializer pipelines committed once per document.** Each op was its own awaited durable
  write; a drained batch now applies in one transaction (chunks of 2 000 ops), with license write
  accounting unchanged — 6 000 docs ≈3.0 s → ≈0.9 s.
- **Embeddings: `createPipeline` dropped the indexer's `flushQuantum` / `drainDeadlineMs`**, so
  they could not be tuned per pipeline; both are now passed through (defaults 32 changes and
  10 min). **`flush()` resolved silently when it timed out**, reporting "indexed" while the
  cursor still trailed; `api.flush({ timeoutMs })` / `indexer.flush()` now reject with
  `INDEXER_FLUSH_TIMEOUT` (default 30 s) — **callers that relied on it always resolving must
  handle the rejection**.
- **Cluster: pause/resume and lease hand-offs took up to 2 s to show in `~processes`.** The
  supervisor now republishes a worker's row (100 ms debounce) when its processing state changes,
  not only on the heartbeat. The CLI's cluster banner no longer calls the supervisor "the
  processor".
- **Docs: `OKDB_BUS_SECRET` was documented but never read.** The bus is namespaced automatically by
  the store's identity (`okdb-<db id>`) — a namespace, not authentication; there is nothing to
  configure. The HTTP-cluster docs also wrongly said the supervisor stays out of the request path:
  on Linux/macOS it accepts every new connection (`NODE_CLUSTER_SCHED_POLICY=none` opts out; see
  [HTTP Clustering → Connection distribution](docs/http-cluster.md#connection-distribution)).

## [2.3.5] - 2026-09-24

### Fixed

- **A blob still referenced by a `~files` record could be deleted.** Two concurrent overwrites of
  one file id (two `upload()`s in one transaction, or in parallel) both released the previous
  blob; when those bytes were shared with another record (dedup), they were unlinked under it and
  its reads returned 404. Releasing a blob — `remove()`, overwrite, `gcOrphanedBlobs()` — now
  re-checks live `~files` references across every registered env before deleting, keeps the bytes
  when any exist (or when an unopened env makes it unknowable), and repairs the ref count.
- **Two uploads of the same id in the same millisecond shared one temp file** (interleaved bytes
  or `ENOENT` on rename).
- **`gcOrphanedBlobs()` could delete a blob an upload was still landing** (a transaction upload's
  blob is on disk before its record commits). It now skips 0-ref blobs modified within `minAgeMs`
  (default 10 minutes; `gcOrphanedBlobs({ minAgeMs })`), and a dedup upload refreshes the reused
  blob's mtime.

## [2.3.4] - 2026-09-24

### Added

- **Searchable file contents: `files.indexContent({ field, maxBytes })`.** Declares `~files.<field>`
  a resolved field backed by a built-in resolver (blob → extractor → text), installed in every
  process automatically, so FTS and embeddings over `~files` need no per-process app code.
  Text-like mimes are extracted out of the box; `files.registerExtractor(match, fn)` adds others
  (mime, wildcard or predicate; no parsers are bundled). A blob missing on the indexing node is
  pulled from sync peers first, else fails retryably with `FILE_BLOB_MISSING`. Also
  `files.get(id)` / `files.read(id)`, and `files.read` / `files.listPath` in functions.
- **Inline file preview: `GET /api/files/:id?inline=1`.** Passive media (non-SVG images, audio,
  video, PDF) keep their type; everything else is served as `text/plain`, always with `nosniff`
  and a sandboxing CSP. Single `Range` requests are honoured (206 / 416).
- **Admin → Files:** a preview pane (text/JSON, images, SVG, PDF, audio/video), a path filter, and
  content search over the `~files` FTS index.
- **The CLI honours the role flags from its config file.** Top-level `processors`, `engines` and
  `compaction` booleans in `.kdbconfig` (or `--config`) are passed to `new OKDB(path, opts)` with
  the constructor's names, defaults and semantics, for the single-process node and every cluster
  worker — so a passive serving node can run from `bin/okdb`. They were silently ignored before.
  A non-boolean value is a startup error.
- **`db.http.listen(port, { host })` binds the API to chosen addresses.** `host` is a string or an
  array (one server per address, sharing one request handler); default unchanged (all
  interfaces). With an array, `listen()` returns the first address's `http.Server`; all of them are
  on `db.http.servers` and `db.http.close()` closes them all. The process registry's `listenAddr`
  shows the bound host(s). The CLI reads `http.host` from its config file (single-process and
  every cluster worker). The documented `listen(port, '0.0.0.0')` form now actually binds that
  host (a string is shorthand for `{ host }`); before, the argument was ignored.

### Fixed

- **Overwriting a file id releases the old blob.** `files.upload()` under an existing id with
  different bytes leaked the previous blob's reference (it was never deleted); same bytes no
  longer double-count.
- **Downloads of files with non-Latin-1 names no longer fail** (`ERR_INVALID_CHAR`):
  `content-disposition` carries an ASCII fallback plus RFC 6266 `filename*`.
- **Blob pulls from sync peers found no peers**: they looked up `~sync_nodes` in the default env
  instead of `~system`. The fetch now has a timeout.
- **Admin → Files: switching folders reloads the file list.**
- **`docs/auth-permissions.md`: the cluster-peer token recipe needs `sync:read` too** — `join()`
  reads `/api/sync/info` first.
- **`docs/auth-and-sync.md` describes the real auth and sync-peer model.** Dropped the `auth.admin`,
  `auth.tokens`, `api.tokens` and `auth.mode` config okdb never reads; tokens live in `~tokens`, and
  peers join once with a token or name + password, then sync with Ed25519-signed requests.
- **A process missing an app registration holds embedding work instead of failing it.** A
  full-role process that lacked the pipeline's custom preparer (`registerPreparer`) or chunk
  strategy (`registerChunkStrategy`), or whose embedder engine was not running (e.g. its
  `registerEmbedderFactory` factory is registered only in another process), marked every doc it
  picked up `failed` for good — measured: with a second such process on the store, 21 of 40 docs
  ended failed and stayed failed after the owner restarted. It now holds them exactly like a
  missing resolved-field resolver: the doc stays `pending`, the inline drain is held (and yields
  its lease to a peer that wants it), a queue job is re-queued without using a try, and
  `indexer.stats().waiting` reports `{ reason: 'REGISTRATION_MISSING', kind, name }` or
  `{ reason: 'EMBEDDER_NOT_RUNNING' }` with a warning in the log. The work completes once the
  registration arrives in that process (registering a preparer/strategy or starting the embedder
  kicks the held drain) or a process that has it picks it up. A misspelled built-in name holds
  too; the message lists the built-ins. Docs already marked `failed` this way by earlier versions
  are not revisited automatically — run `indexer.retryFailed()` once.

## [2.3.3] - 2026-09-24

### Fixed

- **Two processes opening a new store with `OKDB_LICENSE_FILE` are both licensed.** The install
  created the `~licenses` type with a check-then-register, so when two processes (e.g. a
  supervisor and its worker) opened a brand-new store at once, the loser threw "Register Type
  Error: ~licenses already registered", logged `OKDB_LICENSE_FILE not installed` and ran on the
  free tier until restarted. The type is now get-or-created (`ensureType`), a process that finds
  the license already stored by its peer loads it, and a license's record id is derived from the
  license itself, so a concurrent install no longer stores it twice (the id keeps its UUID
  shape). The same get-or-create now covers the other lazily created types that raced the same
  way: `~tokens`, `~files`, embeddings vector types and the indexer's `doc_status` re-creation
  after a rebuild.

## [2.3.2] - 2026-09-24

### Changed

- **An index-maintenance error now aborts the write.** Secondary-index upkeep runs inside the
  writer's transaction; an error there used to be logged and swallowed, so the document committed
  without its index row (a unique index then silently stopped enforcing uniqueness for that key).
  The error now fails the commit and the whole transaction rolls back. Writes that used to
  "succeed" while silently skipping the index will now throw.
- **A non-scalar value in an indexed field is rejected with `INVALID_INDEX_KEY`.** An object,
  array or `Date` in an indexed field could never be indexed; such writes committed without an
  index row and now fail (see above). Index fields take `null`/missing, strings, numbers,
  booleans, bigints or Buffers. A document already stored with such a value (from an earlier
  version) stays updatable and removable: an unindexable old value is treated as having no row.
- **The console log sink honours `OKDB_LOG_LEVEL` (default `info`).** It printed every level, so
  debug lines such as the queue's per-job "job claimed" reached the console. Set
  `OKDB_LOG_LEVEL=debug` to get them back. The `~log` and relay sinks are unchanged.
- **The embeddings `_durable*` accessors are async.** `_durableIndexerStats`,
  `_durableIndexerDocs`, `_durableIndexerDoc` and `_durableWorkerStats` now return promises (see
  Fixed); callers must `await` them. The HTTP routes and pipeline inspect already do.

### Fixed

- **Unique indexes lost their row under a stale lmdb key buffer.** lmdb-js `getValues()` inside a
  write transaction decodes a discarded key from a shared buffer that can still hold the previous
  write's bytes; when those looked like an ordered-binary number the read threw ("The number
  4.7e-66 cannot be converted to a BigInt"). The unique-index check hit it right after its own
  write, and with the error swallowed the job committed without its index row, so the queue's
  idempotency dedup was bypassed (seen while claiming embedding jobs in bulk). Duplicate-value
  reads that can run in a write transaction (index uniqueness, views' live map, time machine,
  FTS live tiers) now use key-bounded range reads that never decode stale bytes. Vacating a
  `null` index key no longer counts the whole `null`-key duplicate set (every claimed queue job
  did this).
- **The embeddings indexer no longer fails a drain on a duplicate job.** Queue-mode indexing
  enqueues a batch in one transaction, so the queue's idempotency fallback didn't apply: a peer
  enqueueing the same doc between the check and the commit failed the batch ("processor drain
  error … Unique constraint violated") and the drain retried. The duplicate now folds into the
  pending job, as a single `enqueue` does.
- **Queue: a job deleted mid-claim is skipped.** A job removed between the claim scan and the
  claim update threw `NOT_FOUND`, which the consumer logged as "worker loop crashed". It is now a
  lost race like a version conflict: the job is skipped and the next one claimed. Both lost-race
  paths return the bucket tokens taken for that job (previously leaked on a version conflict).
- **A drain waiting for a resolver no longer spins.** On reopen of a store with FTS or an
  embeddings indexer over a `resolveField` field, the processor drained before the app registered
  the resolver and retried in a hot loop (~800 "processor drain error" warnings in 1.5 s). It now
  holds quietly (cursor unchanged, `status().waiting` set, one debug line) and resumes when the
  resolver is registered, on the next write, or on the catch-up tick. A holding process yields
  its lease at once to a peer that wants it.
- **Embeddings durable stats see pipelines created by another process.** The durable indexer and
  worker stats looked for the pipeline's sub-env only among envs already open, so a process that
  attached before another process created the pipeline reported `done 0 / pending N`. They now
  open the sub-env on demand.
- **The embeddings restart safety net resets only when vectors are really lost.** It reset the
  cursor whenever the vector store was empty, so a pipeline whose docs legitimately yield no
  vectors re-ran every doc on every restart. It now resets only when `doc_status` is missing or a
  done, non-empty doc expects a vector that isn't there — and that reset now actually re-indexes
  (it drops `doc_status` first, as `rebuild()` does; before, surviving done rows skipped every
  doc).

## [2.3.1] - 2026-09-24

### Fixed

- **`ensureType` is race-safe across processes.** It checked for the type and then registered it
  in a separate step, so two processes creating the same type in a shared env raced and the loser
  threw "Register Type Error: <type> already registered" (seen when two processes opened the same
  fresh env at first boot). The existence check now runs inside the write transaction, and a
  peer's win counts as success. Indexes passed to `ensureType` get the same treatment: an index a
  peer registered is adopted instead of being created or rebuilt a second time. Internal
  check-then-register sites (`~envs`, `~engines`, `~pipelines`, functions, views, process
  registry, `doc_status`, …) now use `ensureType`. An explicit `registerType` of an existing type
  still throws.
- **The embeddings indexer commits as it goes.** An inline drain embedded every text of its batch
  (up to 1 000 docs) before writing any vector or `doc_status` row. A large bootstrap showed zero
  progress for many minutes (about 19 min for 372 source files on a local model), and a restart in
  that window lost all of it. Vectors and `DONE` rows are now written every ~128 texts
  (`batch` × 4), so progress is visible and durable, and a re-run skips committed docs.
- **A slow embeddings backlog no longer freezes the rest of the instance.** The indexer drained in
  5 000-change quanta, so a backlog of network-bound embed calls held the instance's processor
  gate for the whole build (FTS and other pipelines' indexers sat still) and tripped the 60 s
  drain deadline into error/retry cycles. It now drains in 32-change quanta, releasing the gate
  between them, with a 10-minute drain deadline. Both can be overridden per pipeline
  (`config.flushQuantum`, `config.drainDeadlineMs`).
- **`createPipeline` repairs a pipeline whose member engines are missing.** An existing pipeline
  record always refused with "Pipeline already exists", so a record left pointing at engines that
  were gone (removed, or lost to an interrupted create in another process) could never index and
  could not be recovered by re-running an idempotent create. Missing members are now re-created
  (existing ones reused) and a warning names them. A complete pipeline still refuses.
- **Named processor handlers work with two OKDB instances in one process.** The named-handler
  registry is process-global, but the indexer, pipeline-processor and materializer drivers keep
  their runtime per instance. A processor registered on the first instance after a second
  instance opened dispatched to the second instance's handler, found nothing to do, and advanced
  its cursor anyway, so those changes were silently never processed (e.g. a new pipeline or an
  engine restart on a host's own store while an embedded library's store is also open). Handlers
  now resolve their instance through a driver id carried in the processor payload.

## [2.3.0] - 2026-09-24

### Added

- **Resolved fields** (`env.resolveField(type, field, fn)`): index content okdb never stores.
  FTS (live drain and builds), the embeddings indexer and search-result chunk text read the field
  through an app-registered resolver when a row has no stored value — e.g. rows of `{ rel, hash }`
  with file text served from disk. The declaration is durable; a process that runs those indexes
  without the resolver holds them with `FIELD_RESOLVER_MISSING` (the drain waits for the resolver;
  no doc is marked failed) instead of indexing empty text. A resolver error fails that item only. Also `unresolveField`, `resolvedFields`, `readField`.
  **Batch resolvers** (`resolveField(type, field, fn, { batch, batchSize })`) resolve many rows per
  call — FTS drains/builds and the embeddings indexer prefetch a whole batch in one call (for a
  remote source: one round trip per batch instead of per row).
  Measured on okdb's own `src/` (265 files, 5.2 MB): identical FTS and vector results, source
  env 2.6 MB → 0.27 MB. See `docs/resolved-fields.md`.
- Vector search views: `algorithm_config.idleEvictMs` (or `OKDB_VECTOR_VIEW_IDLE_EVICT_MS`) sets
  a view's idle-eviction delay (default 5 min; `0` keeps it resident; `stats()` reports it), and
  usearch `algorithm_config.snapshotMaxLagMs` bounds reader lag (see Fixed).
- `okdb.embeddings.getEmbedderFactory(type)` / `getEmbedderSchema(type)`: the factory (built-in or
  registered) and field schema of an embedder type, e.g. to wrap a built-in provider and supply its
  API key at runtime instead of storing it in the pipeline's durable config.
- **`db.licenses`** — install and inspect licenses from code (after `open()`): `add(input)` takes
  a license blob, an activation token (auto-detected) or `{ blob, activation }`, takes effect
  immediately, and is idempotent (re-adding a stored license returns it with `changed:false`);
  `activate(token)`, `remove(id)`, `list()`, `get(id)`, and `effective()` (the active license or
  the free tier, with `enforced`). Results are summaries (`id`, `type`, `status`,
  `needsActivation`, `pin`, `expiresAt`, `features`, `limits`) — never the blob or token. The
  admin license routes and `okdb license` now go through it. See `docs/licensing.md`.
- **`OKDB_LICENSE_FILE`**: `open()` installs the license in that file (blob, token, or both)
  through the same idempotent path, before license-gated features and engines start. A missing or
  invalid file is a warning (error code only, never the content); `open()` continues.

### Changed

- **Free tier covers embeddings pipelines and 5 environments** (unlicensed prod builds), so an
  embedded code index — a management env plus one env per workspace, each with an embeddings
  pipeline — works out of the box for up to three workspaces. `embeddings` is on: the members of
  an embeddings pipeline (embedder, indexer, vector-search, embed-worker engines) are licensed by
  `embeddings` as well as `engines`, and load at open when either is enabled (previously an
  unlicensed boot skipped every engine). A new free-tier-only limit, `pipelinesPerEnv` (2), bounds
  them — counted as the env's indexer engines, refused before any member is created. `envs`
  (which counts `default`) is 5, was 2. The generic `engines` platform (custom drivers,
  standalone engines of other types) stays licensed. Paid licenses are unaffected: the license
  format has no `pipelinesPerEnv` field, so a license is never bounded by it; a license with
  `embeddings` but not `engines` can now actually run pipelines. Internal (`~`) envs, which the
  `envs` limit never counted, are no longer refused by it either (a pipeline's
  `~<env>:emb:<type>` env failed once the user envs were at the limit). See `docs/licensing.md`.
- Admin license routes (`POST /admin/license`, `POST /admin/license/:id/activate`) return the
  license summary (no raw blob/token), and re-adding a stored license is an idempotent success
  (was a 400 "License already stored"). `okdb license <blob>` likewise reports "already stored"
  instead of failing. Internally a duplicate add is `LICENSE_ALREADY_STORED` (was
  `LICENSE_INVALID`, the same code as a bad signature).
- **Embeddings indexing rebuilt around one idempotent `reconcile`.** For each document the
  indexer compares the chunk content hashes the source doc calls for with the vectors actually
  stored, embeds only the missing ones, deletes the stale ones, and records the outcome. Inline
  drains and queue workers share it. Measured on 100 docs × 768 dims, half of them edited once:
  the embeddings env per doc went from 100 → 34 KB (queue, chunked), 61 → 30 KB (inline,
  chunked), 13 → 9 KB (queue, unchunked).
    - Queue jobs are references: payload `{ key }` only (was the full job context plus a copy of
      the chunk text), one job per doc (was one per chunk), write bursts folded into the pending
      job (`idempotency_scope: 'pending'`, see below). New `debounce` option (ms) holds jobs back so
      an edit burst embeds only the final text.
    - Embed requests are batched (`batch`, default 32), across documents in inline mode.
      `embedBatch(texts)` is a new optional embedder hook; the built-in `openai` and `ollama`
      embedders implement it natively (one HTTP request per batch).
    - Editing a field the pipeline doesn't embed costs no embed call and no write (was a full
      re-embed). Non-chunked docs record a content `hash` for this.
    - The hash→vector cache is a bounded LRU (`cache`, default 1024) instead of every stored vector
      loaded into memory at startup.
- **Vectors are stored as raw float32 bytes** (3 KB per 768-dim vector, was ~6.9 KB as a msgpack
  float64 array). A raw `vec:` row read through the generic data API is now a byte buffer, not a
  number array — use `okdb.embeddings.getVector()`. Pre-2.3 rows still decode (the migration
  keeps them); they convert as they're rewritten.
- **`doc_status` rows are trimmed** to `source_key`, `status`, `version`, `clock`, `updated`,
  `error`, `empty`, and `hash` (unchunked) or `chunks[{hash,start,end}]`. Gone: `engine_key`, `mode`, `created`,
  `chunk_strategy`, `total_chunks`, chunk text. `error`/`empty` are present only when set.
  Rows are ordered by the source doc `version` and never regress.
- **Deleting a source doc deletes its `doc_status` row** (no `deleted` tombstones kept forever).
- **`chunk_status:<storage_key>` is gone** (a second copy of every chunk manifest, rewritten per
  chunk). `listDocStatus` still reports `chunk_done` for chunked docs.
- **`chunk.storeText` is ignored**: chunk text is no longer copied into `doc_status`; search
  results derive it from the current source doc (`okdb.embeddings.describeChunk()`). The admin
  UI's "Store chunk text" checkbox (on by default) is removed.
- **Storage migration `2.3.0` / `embeddings-lean-layout`** (runs once on first open, before
  engines boot, recorded in `~migrations`): drops each pipeline's pre-2.3 `doc_status`,
  `chunk_status` and queued embedding jobs, removes vectors whose source doc no longer exists,
  and resets the indexer to replay from clock 0.
  Vectors are kept — chunked docs rebuild their status from the stored chunk hashes with **no
  embed calls** and search keeps serving throughout; unchunked docs re-embed once (pre-2.3 rows
  carry no content hash). `OKDB_EMBEDDINGS_REEMBED=1` also drops the vectors for a full
  re-embed. The store is stamped `2.3.0`, so okdb 2.2.x refuses to open it (it cannot read
  the new vector encoding).
- `okdb.embeddings.describeChunk()` is now async (it may read a resolved field).
- Indexer API: `reconcile(key, { heartbeat })` added (the embed-worker's entry point);
  `markDone` no longer takes a `chunks` manifest; `markDelete` removes the row.
- Queue: `enqueue(..., { idempotency_scope: 'pending' })` — the idempotency key dedups against
  pending jobs only and is released at claim, so a change arriving while a job runs enqueues a
  follow-up instead of folding into the running job.

### Fixed

- **Queue calls wait out a peer's compaction instead of failing.** When another process
  compacted the env, this process closed its handle for the ~seconds-long swap, and any queue call
  in that window (`enqueue`, `markJobComplete`/`Fail`, `releaseClaim`, `getJob`, …) threw
  `INVALID_STATE` "OKDB not opened" from its first read before reaching the write path's drain
  park. Enqueues were lost, and finished jobs stayed `running` until their claim expired. Queue
  entrypoints now wait for the reopen, as `env.put`/`txn` already did; a genuinely closed env still
  fails immediately.

- **Vector search views now always converge to the stored vectors** (usearch and hnsw; flat
  already did). A view that idle-evicted (5 min without a search) skipped live updates while
  unloaded, and its next load served its own stale snapshot without replaying the stored
  vectors — anything embedded while it was unloaded was missing from the graph for good (load 5,
  evict, add 10, reload → 5 of 15). Every load (and every reader→writer promotion) now diffs the
  snapshot against the `vec:` rows via per-key vector fingerprints stored with the snapshot
  (labels v2) and applies the missing adds, replaced vectors and removes. A pre-2.3 snapshot
  (no fingerprints) is rebuilt from the rows once.
- **usearch: a process holding `WRITER.LOCK` could be a reader, leaving nobody to write the
  graph** (~2 in 10 evictions landing near a change-count publish). Ownership was by pid, so an
  evicted view's replacement worker in the same process didn't recognise — or could release —
  its sibling's lock; and a live update delivered to the not-yet-loaded replacement promoted it
  to writer, after which its own load saw its fresh lock and turned reader while its heartbeat
  kept the lock alive. The lock is now owned by a per-instance token (a writer whose lock was
  taken over demotes itself), writes to an unloaded instance are dropped (the load reconciles
  them), the fanout tail pins the instance for a batch, and a reload waits for the evicted
  instance to publish and release first. A reader whose writer is gone takes over on its next
  search instead of serving the last snapshot forever.
- **usearch/hnsw: change-count snapshot publishes stopped after the first eviction.** Snapshot
  ids mixed two clocks — the changelog counter (change-count publishes) and `Date.now()`
  (stop/eviction/explicit publishes) — so after one wall-clock publish every change-count publish
  was rejected as stale, readers froze at that snapshot, and every later add re-saved the whole
  index into a tmp dir that was then discarded. Internal publishes now use one monotonic id.
- **usearch readers are fresh within `snapshotMaxLagMs` (new, default 10 s)**: the writer
  publishes once the oldest unpublished change is that old, stretched to 10× the last publish's
  duration so a large index spends at most ~10% of its time saving. `snapshotEveryChanges`
  (still 50 000) is now only a burst cap; as the only trigger it meant a reader of a typical
  (< 50k) index never saw a publish until the writer's view was evicted.
- hnsw: growing past capacity rebuilt the graph from the rows captured at load, dropping every
  vector added since; it now resizes in place.
- A usearch reader's cold load no longer reads and ships every stored vector to its worker
  thread (the algorithm pulls rows only when it needs them); vectors cross to the worker as
  Float32Arrays instead of boxed arrays.
- Search view `rebuild()` on an unloaded view marked it loaded without loading it.
- `removeEnvironment` deleted sub-environment directories (e.g. the embeddings env
  `~<env>:emb:<type>`) using their RELATIVE registry path, i.e. relative to `process.cwd()`:
  the real directory was left behind, and a same-named directory in the current working
  directory would have been deleted instead. Paths now resolve under the store root, and a
  non-absolute path is refused.
- Chunked queue-mode pipelines left the previous version's chunk vectors in place on every update
  (a doc edited once held twice its vectors; search could match text the doc no longer has),
  embedded superseded versions from queued jobs, and could report a doc DONE for an older
  version while its current chunks were still pending.
- Deleting a source doc from a chunked queue-mode pipeline never removed its vectors (the delete
  path called a storage `scan()` that the vector store doesn't have), so deleted docs stayed
  searchable. The 2.3.0 migration removes the leftovers.
- `durableRetryDoc`/`durableRetryFailed`/`durableRebuild` now work for chunked queue-mode
  pipelines too.
- Queue-mode embedding pipelines kept every completed job and its payload forever
  (`~queue_jobs` / `~queue_payloads` in `~<env>:emb:<type>`) — one row pair per document, or
  per chunk for chunked pipelines (whose payloads carry a copy of `chunk_text`), re-added on
  every source update and "Re-embed all". Embedding jobs are now enqueued with `done_ttl: 0`
  (deleted on completion; `doc_status` remains the durable record); jobs left by older builds
  are dropped by the 2.3.0 migration. Failed jobs are still kept for inspection/retry. Side effect: the worker's "Queue" metric
  now shows the real backlog instead of every job ever enqueued.
- **Writer: a transaction issued while another was held open ran nested inside it.** lmdb-js keeps
  an async write txn open while its callback's promise is pending (FTS holds its post txn across
  the docs commit); a `childTransaction` issued in that window ran synchronously inside the
  holder's txn — the write silently joined it (lost if the holder aborted) and the writer crashed
  on the non-promise result. New transactions on that writer now wait for the hold to settle; a
  nested result from a caller outside the writer is accounted for and warned instead of crashing.
- **A failed FTS build left the index stuck in `RESETTING`** and `fts.ready()` waiting forever. The
  index now goes to the `error` state (message in `fts.list(type)[i].error`) and `ready()` rejects
  with `FTS_BUILD_FAILED`; `fts.reset()` or the next `open()` retries the build.
- A pending FTS reset racing a type drop crashed on its own "dropped before the reset completed"
  guard.
- `removeEnvironment` (and env close) now deregisters the env's engines in-process — re-creating
  the env and its pipeline in the same process failed with "Engine already exists".
- `pipelines.remove` now drops the pipeline's vectors and resets its indexer cursor (vectors were
  kept forever, and a re-created pipeline skipped docs it had indexed before); `indexer.rebuild()`
  on the lazy vector adapter really drops the vectors now.
- `embeddings.durableRebuild()` from a passive (`processors:false`/`engines:false`) process now
  reaches the live indexer in the owning process (durable command epoch + a processor hint)
  and makes it re-embed (the live indexer never noticed); a restart does not replay the reset.
  Processors no longer re-run their last command at every registration, and a registration
  stopped while acquiring its lease no longer leaks a heartbeating lease.
- `bus.stop()` flushes pending sends — hints sent right before close/exit were lost.
- Admin UI: works with `@kedem/okjs` 1.3 (its import of the removed `ok-crash-info` component
  failed the whole module graph; the crash screen's details now come from
  `ok-crash-explorer-service`), and Enter-to-submit works again in 10 dialogs
  (`@keydown:enter` — `@keydown.enter` never bound a key filter).

## [2.2.1] - 2026-08-25

### Fixed

- **Regression in 2.2.0**: `query()` with an `index` + `reverse: true` + any bound (`prefix`,
  flat `startIndex`/`endIndex`, or the nested `index: {fields, start, end}` form) silently
  returned zero rows instead of the correct descending range. Caused by 2.2.0's own
  `byIndex`/`getIndex`/`countByIndex` reverse-swap fix stacking on top of `query()`'s
  pre-existing internal swap — the two canceled out. Fixed by splitting `byIndex()` into a
  public normalizing wrapper and a private `_byIndexCore` that `query()` calls directly,
  bypassing the double normalization. Direct `byIndex()`/`getIndex()`/`countByIndex()` callers
  are unaffected.

## [2.2.0] - 2026-08-25

### Fixed

- `byIndex`/`getIndex`/`countByIndex({prefix})` silently ignored `prefix` and returned the
  whole unfiltered index instead of a prefix match.
- `byIndex`/`getIndex`/`countByIndex` combined with `reverse: true` and natural-order
  `start`/`end` silently returned zero rows (lmdb's own reverse convention wants `start` as
  the higher bound; these now swap automatically, matching the documented direction-independent
  contract).
- `query()` silently ignored a flat `start`/`end` option (only `startIndex`/`endIndex`, or the
  nested `index: {start, end}` form, were ever wired up) and ran an unfiltered scan instead.
  Passing `start`/`end` now throws immediately, pointing at the correct option names.
- `OKDBTransaction.query()` was not honoring `useReadTransaction` — a `txn.query()` call inside
  a `useReadTransaction: true` transaction silently read live data instead of the transaction's
  pinned consistent snapshot, unlike its `getRange`/`byIndex`/`get` siblings on the same
  transaction. `query()` now threads the transaction through correctly.
- `$countBy` view results: `docs/views.md` and `types/features/views.d.ts` documented/typed a
  plain `{ [groupKey]: { value } }` shape; the actual (correct, unchanged) runtime shape is the
  paginated `{ totalGroups, preview: [...], hasMore, cursor }`. Docs and types corrected to
  match reality — this also affects `$group` and `$ref`-nested grouped reducers, and the
  `range()`/bucketed-view output shape.
- `docs/embeddings.md`: indexer `stats()` documented as `{ total, pending, embedded, failed }`;
  actual shape is `{ doc_counts: { pending, done, failed, deleted, total }, ... }`.

### Changed

- **New strict option validation**: `getRange`, `getKeys`, `getCount`, `getIndex`, `byIndex`,
  `countByIndex`, and `query()` now throw on any option key outside that method's real
  vocabulary, instead of silently ignoring it. This is the root-cause fix behind several of the
  bugs above — an unrecognized option previously produced a plausible wrong answer instead of an
  error. **This can be a breaking change** for callers passing a typo'd, extra, or
  wrong-surface option key that was previously tolerated silently (see `types/options.d.ts`:
  `OKDBQueryOptions` for `query()`'s real vocabulary, `OKDBIndexRangeOptions` for
  `byIndex`/`getIndex`/`countByIndex`'s).
- `types/options.d.ts`: split `OKDBQueryOptions` (query()'s vocabulary — `start`/`end` removed,
  `endIndex`/`startKey`/`endKey` added) from a new `OKDBIndexRangeOptions`
  (`byIndex`/`getIndex`/`countByIndex`'s lmdb-native vocabulary). They previously shared one
  type, which is how `start`/`end` leaked into `query()`'s type despite never being implemented
  there.

### Docs

- `docs/querying.md`: added the previously-undocumented `startIndex`/`endIndex` example for
  non-prefix index ranges in `query()`, and notes on the new throw-on-unknown-key behavior and
  the direction-independent `start`/`end` guarantee.

## [2.1.2] - 2026-08-21

### Fixed

- Admin engines page: `ACTIVATION_FAILED` on load — an inline `.ok.html` `<script type="module">`
  is loaded via a blob URL with no hierarchical base, so a relative import to a plain
  (non-`.ok.js`) file failed. Inlined the helper instead of importing it.
- `release-check.js`'s tag-vs-HEAD comparison broke on annotated tags (`npm version`'s default):
  `refs/tags/<tag>` resolves to the tag _object's_ own SHA for an annotated tag, not the commit
  it points at, so the comparison never matched even when the tag was correctly placed. Now peels
  annotated tags to their target commit before comparing.

## [2.1.1] - 2026-08-21

### Fixed

- Passive-node (`engines: false`) embedding pipeline visibility: a node not running its own
  engines showed members as "missing" with zero progress, and every action
  (retry/rebuild/view vector) either threw `ENGINE_NOT_RUNNING_HERE` or silently no-opped — even
  when the pipeline was running fine on a separate `engines: true` process against the same
  path. Status/progress/actions now distinguish "running elsewhere" (remote) from genuinely
  missing/broken, and read real progress, doc status, vectors, and processor cursors directly
  from durable LMDB state instead of requiring a live in-process engine.
- `doc_counts.total` was undercounting mid-bootstrap/rebuild (only counted rows touched so far).
- Doc listing, mark done/failed/deleted, and single/bulk retry now work durably on a passive
  node; empty content is correctly `DONE`, not `FAILED` (was polluting the failed count and
  looping forever on retry).
- "Re-embed all" actually wipes+resets+re-enqueues now, instead of a silent no-op 200.
- "View vector" reads vectors directly from LMDB (including chunked pipelines) instead of
  requiring a live engine's in-memory cache.
- Fixed a vector-write bug where `markDone`/`markDelete` silently skipped the actual vector
  write in the default (no custom resolver) setup.
- Admin UI: pipeline-list members read the correct response field; progress bar live-updates
  and stays visible at 100% on completion.

## [2.1.0] - 2026-08-08

### Changed — the safe-range contract (env-balloon fix)

LMDB range readers can no longer pin the freelist past a synchronous block: default
`getRange`/`getKeys`/`getValues` are renewable (an iterator held across an `await` neither
balloons the file nor breaks); pinned surfaces (`snapshot: true`, `byIndex`/`getIndex`,
`getChanges`, `useReadTransaction`) throw `READER_HELD_ACROSS_AWAIT` deterministically on
suspension, with an opt-in `'tolerant'` park-and-resume mode for callers who want it. See
`docs/upgrade-2.1.md` for the full contract and migration notes.

### Added

- Storage observability: per-env reclaimable %, reader pins, and compaction outcome surface in
  the admin Environments table and env overview.
- Compaction temp-dir orphans are reaped on `open()`.

## [2.0.x] - 2026-07-07 – 2026-08-08

**okdb 2.0: the operator-managed rewrite.** Envs open lazily; async `OKDBWriter` funnels every
write through one choke point per env; `OKDBProcessor` unifies change-subscription across
views/indexes/FTS/materializer/embeddings/time-machine with a cooperative hold-window lease as
the load balancer; HTTP clustering, the function sandbox, and subscriptions v2 landed. See
`docs/upgrade-2.0.md` and the Architecture section of `CLAUDE.md` for the full model — this file
starts tracking change-by-change detail from 2.1.0 onward.
