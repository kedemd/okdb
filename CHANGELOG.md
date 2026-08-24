# Changelog

All notable changes to `@kedem/okdb` are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versions follow [SemVer](https://semver.org/).
Dates are release dates.

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
