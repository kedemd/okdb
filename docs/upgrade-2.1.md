# Upgrading to okdb 2.1 — the safe-range contract

okdb 2.1 fixes the **env-size balloon**: LMDB data files growing far past their live data
until a compaction rescued them. Storage formats, the document model, and all APIs are
**unchanged**, and **default-path code needs no changes at all** — including loops that
`await` while iterating a range.

> **The one-sentence contract.** Default range reads can no longer pin the database:
> `getRange` / `getKeys` / `getValues` / `getByPrefix` use a renewable read transaction, so
> an iterator held across an `await` neither balloons the file nor breaks. The explicitly
> **pinned** surfaces (`snapshot: true`, `byIndex` / `getIndex`, `getChanges`) release
> their cursor at any suspension and throw **`READER_HELD_ACROSS_AWAIT`** —
> deterministically; `'tolerant'` mode opts into resume-while-quiet.

## Why

LMDB is copy-on-write: every commit frees the pages it replaces, and a freed page can be
recycled only when **no reader in any process** still holds an older snapshot. A pinned
range cursor held across an `await` blocks free-page reuse for the _entire_ env while
writes churn, and the file grows by _pages-dirtied-per-commit × commit count_ (≈24 KB
floor per commit) — completely decoupled from ingestion volume. One parked iterator plus
background churn = gigabytes. Reproduced and measured in `repro/reader-balloon.js` and
`repro/reader-balloon-amplify.js`.

## What each surface does now

| Surface                                                                  | Default behavior                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getRange` / `getKeys` / `getValues` / `getByPrefix`                     | **Renewable** — iterate however you like, `await` freely mid-loop; per-row consistency (a resumed iterator sees writes that landed ahead of it); nothing pins.                                                                                                                                                                                                                                                   |
| `getRange(type, { snapshot: true })`, `getKeys(..., { snapshot: true })` | **Pinned + strict guard** — one frozen view that must be consumed in one synchronous block. On suspension the cursor is released (nothing pins past one synchronous block, abandoned iterators included) and the next `next()` throws `READER_HELD_ACROSS_AWAIT` — **deterministically**, quiet env or busy: the violation fails on first run at your desk, never intermittently under production write traffic. |
| `{ snapshot: 'tolerant' }`                                               | Opt-in park-and-resume: same release-at-suspension, but the next `next()` resumes transparently **iff no commit of any kind landed meanwhile** (LMDB's env-wide `lastTxnId` unchanged — cross-process accurate) and throws only when the frozen view is genuinely unkeepable. Note this makes the error load-dependent — opt in only when that is what you want.                                                 |
| `getChanges`                                                             | Pinned + strict guard (renewal is not supported on the clock sub-DBs). `{ snapshot: 'tolerant' }` opts into the resume rule.                                                                                                                                                                                                                                                                                     |
| `byIndex` / `getIndex`                                                   | Pinned + strict guard — dupSort stores have no unambiguous resume bookmark, so any suspension throws. Materialize (`Array.from`) before awaiting.                                                                                                                                                                                                                                                                |
| explicit `{ transaction }` / `OKDBTransaction`                           | Bypasses the guards — the pin is caller-scoped (see below).                                                                                                                                                                                                                                                                                                                                                      |

If you hit the error, the fix is one line — materialize before the `await`:

```js
for (const { value } of Array.from(env.byIndex('orders', ['status'], { values: ['open'] }))) {
    await handle(value);
}
```

or chunk large scans with keyed continuation (`{ limit, start, exclusiveStart }` per batch).

## `useReadTransaction` — same rule, transaction-shaped

`env.transaction({ useReadTransaction: true })`'s consistent read view is released at the
first turn boundary after creation (so a transaction that is never committed can no longer
leak its pin). Reads after that throw `READER_HELD_ACROSS_AWAIT` — deterministically: do
all consistent reads before any `await`. `useReadTransaction: 'tolerant'` opts into the
resume rule instead (reads stay valid while nothing has been committed; the first
interleaved commit makes them throw). Writes are unaffected either way: they are buffered
intents, applied atomically at `commit()` with `ifVersion` checked against current state,
exactly as before.

Note the guard checks are **env-wide and conservative**: any commit — including internal
bookkeeping — counts as "the env was written."

## Rolling upgrades

The renewable default and the guards live in the upgraded process. A **2.0.x peer sharing
the same store path can still pin** shared envs the old way until it is upgraded — the
process-registry mixed-build warning tells you when a fleet is split. Upgrade all
processes on a path.

## History worth keeping (internal)

An earlier build shipped the renewable default and **segfaulted** — root cause was okdb's
_own_ boot loops holding renewable cursors across awaits into env close/rebuild windows.
Seven internal sites were fixed (materialized or chunked; the boot env-registry loop had
been pinning `~system` for the entire multi-env open). Internal scans must stay
synchronous or chunked; `tests/getrange-snapshot-default.test.js` keeps the crash shape
(env close with a held renewable iterator) permanently covered.
