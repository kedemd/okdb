# Migration & Export

OKDB's migration feature handles export/import of all types and records as JSON / NDJSON, plus blob export/import for file storage, blob integrity tools, and hot filesystem **backup / restore** of the whole store.

| You want                                  | Use                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| a restorable copy of the whole store      | [`migrate.backup(dir)`](#hot-backup-and-restore) / `okdb backup` + `okdb restore` |
| portable, version-independent data        | [`migrate.exportToFile()`](#streaming-export-ndjson) / `okdb export`              |
| a small in-memory snapshot (tests, demos) | `migrate.export()` / `exportJSON()`                                               |

---

## Export

```javascript
const data = await okdb.migrate.export();
```

Returns an object:

```javascript
{
    types: {
        users: {
            entries: [
                { key: 'alice', value: { name: 'Alice', role: 'admin' }, version: 3 },
                { key: 'bob',   value: { name: 'Bob',   role: 'member' }, version: 1 },
            ],
            indexes:    [...],    // index definitions
            ftsIndexes: {...},    // FTS index definitions
            schema:     {...},    // JSON Schema { definition, enforce } if set
        },
        orders: { entries: [...] },
    },
    meta:    {},     // empty unless includeMeta: true
    changes: [],     // empty unless includeChangeLog: true
}
```

**Indexes** are exported and restored on import. **JSON Schemas** (including foreign key `ref` annotations and `enforce` mode) are preserved across export/import. On import, schemas are applied after all data is loaded so `enforce: true` validation succeeds.

### Options

```javascript
const data = await okdb.migrate.export({
    includeMeta: false, // include field schema metadata
    includeChangeLog: false, // include the clock/change log entries
});
```

### Export to JSON string

```javascript
const json = await okdb.migrate.exportJSON({ pretty: true });
fs.writeFileSync('./backup.json', json);
```

---

## Import

```javascript
const data = JSON.parse(fs.readFileSync('./backup.json', 'utf8'));
await okdb.migrate.import(data);
```

:::warning
Import **drops all existing types** before recreating them. This is a destructive operation. Back up your data first.
:::

Import recreates all types, populates records with their exact versions (preserving optimistic-concurrency state), and optionally restores the change log.

### Import from JSON string

```javascript
const json = fs.readFileSync('./backup.json', 'utf8');
await okdb.migrate.importJSON(json);
```

---

## Blob export / import

File blobs (from the [Files](./files.md) feature) are stored separately from the OKDB types. Exporting and importing blobs is a separate step:

```javascript
// Export blobs to a target directory
const { count, bytes } = await okdb.migrate.exportBlobs('./backup-blobs');
console.log(`Exported ${count} blobs, ${bytes} bytes`);

// Import blobs from a source directory (skips blobs already present)
const { imported, skipped } = await okdb.migrate.importBlobs('./backup-blobs');
console.log(`Imported ${imported}, skipped ${skipped} already present`);
```

The blob directory layout is preserved: `<dir>/<first2>/<rest>` (matching the SHA-256 hex filename structure).

---

## Blob integrity

Validate that blobs on disk match the `~files` metadata records:

```javascript
const issues = await okdb.migrate.validateBlobIntegrity();

if (issues.length === 0) {
    console.log('All blobs intact');
} else {
    for (const issue of issues) {
        console.warn(issue.type, issue.message);
    }
}
```

Issue types returned:

| Type           | Description                                                         |
| -------------- | ------------------------------------------------------------------- |
| `missing_blob` | A `~files` record references a hash that has no blob on disk        |
| `zero_refs`    | A blob's ref-count is zero but a `~files` record still points to it |
| `orphan_blob`  | A blob file on disk has no `~files` record in any environment       |

### Repair ref-counts

If ref-counts get out of sync (e.g. after a crash or manual blob manipulation), rebuild them from scratch:

```javascript
const { rebuilt } = await okdb.migrate.repairBlobRefs();
console.log(`Rebuilt ref-counts for ${rebuilt} blobs`);
```

---

## Streaming export (NDJSON)

```javascript
await okdb.migrate.exportToFile('./export.ndjson', { envName: 'default', types: null, includeChanges: false });
await okdb.migrate.exportToStream(writable, { envName: 'default' }); // any Writable; you close it
await okdb.migrate.exportEnvsToStream(writable, { envNames: null }); // every user env, one stream
await okdb.migrate.importFromFile('./export.ndjson', { dropExisting: false, batchSize: 500 });
```

One JSON record per line (`header`, `env`, `schema`, `data`, `change`). The export is
**cooperative**: rows are read and written in 1 000-row chunks, the loop yields between
chunks, and `drain` is awaited whenever the stream's `write()` returns `false` — exporting
200 000 docs holds the event loop for at most one chunk (≈10 ms, down from a ≈0.6 s single
stall) and buffers ≈0.3 MB instead of the whole 52 MB export, however slow the consumer.

**Consistency is per chunk, not point-in-time.** Each chunk is read from its own LMDB
snapshot and released before the next `await` (a snapshot reader may not be held across an
await — see the safe-range contract in [querying.md](querying.md)); the next chunk resumes
strictly after the last exported key. So every key is exported at most once, a key that
exists for the whole export is exported exactly once with the value it had when its chunk
was read, and rows written concurrently may or may not appear. Different types (and chunks)
reflect different moments. For a point-in-time copy use [`backup()`](#hot-backup-and-restore)
(one snapshot per env), or export a quiescent store.

---

## Hot backup and restore

```javascript
const r = await okdb.migrate.backup('/backups/okdb-2026-09-24', { envNames: null, compact: true });
// r = { ok, dest, envs: [{ name, dest, sizeBefore, sizeAfter, timeMachine }], blobs: { count, bytes }, skipped, manifest }
```

```bash
okdb backup /backups/okdb-2026-09-24 --path ./okdb-data
okdb restore /backups/okdb-2026-09-24 --path ./okdb-restored   # target must not exist or be empty
```

`destDir` must not exist (or be empty) and must not be inside the store — a backup never
overwrites. The result directory **is a store**: open OKDB on it (or on a copy of it).

**What is copied**

| Part                                                                             | How                                                                                                                        | Notes                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every env (`~system`, `default`, user envs, `~log`, `~sub`, embeddings sub-envs) | LMDB native copy (`mdb_env_copy2`, compacting when `compact`) — one read snapshot per env, safe against concurrent writers | each env lands at its path relative to the store root, so the copied env registry resolves it. `envNames` narrows the set; `~system` (env registry, identity, licenses, token secret) is always included so the copy opens — unselected envs open empty                                                                                   |
| each env's time-machine history (`<env>/time-machine/`)                          | LMDB native copy, immediately **before** its env                                                                           | history is not derivable (the changelog it was built from is GC'd). Two LMDB envs cannot share one snapshot: diffs for writes committed _while the env file itself is copied_ are missing from the copy; the restored time machine resumes from the env's cursor, so a key written in that window gets one coarser diff on its next write |
| file blobs (`~blobs/`)                                                           | file copy **after** all env metadata, skipping the `tmp/` upload staging dir                                               | an upload during the backup is at worst an orphan blob; a file _deleted_ during the backup (refs → 0 unlinks the blob) can leave a `~files` record without bytes — run `migrate.validateBlobIntegrity()` on the restored store                                                                                                            |
| `okdb-backup.json`                                                               | written last                                                                                                               | manifest (version, envs, blob count, exclusions); its presence marks a complete backup — `okdb restore` refuses a directory without it                                                                                                                                                                                                    |

**What is not copied**

- `~fts/` — full-text indexes are derived, and live in a separate LMDB env whose indexing
  cursor is stored in the data env, so no copy order would make the pair consistent. The
  restored store notices the missing `~fts` files on its first open and **rebuilds every
  index from the documents** (demoting them to `creating` until done — `fts.ready()` waits;
  cost: one full re-tokenize of the indexed types).
- `~processes` — the live process registry (disposable; rebuilt by the running processes).
- quarantined envs (failed to open) — reported in `skipped`.

**Restore** = put the backup directory where the store should live and open it:
`okdb restore <backup> --path <target>` copies it into a new/empty target. Things to know:

- The restored store has the **same node identity** as the source. Do not run it as a sync
  peer alongside the original — restore replaces a node, it does not clone one.
- An env registered with an absolute path _outside_ the store (legacy / hand-edited records
  only; `createEnvironment` always places envs under the root) is copied to its default
  placement and flagged `outOfTree` in the manifest; while its original path still exists,
  the restored store opens that original directory. `okdb restore` warns about this.

**Remote backups (HTTP / MCP).** `POST /api/system/backup` (MCP `system_backup`) writes only
under the server's backup root — the `backup.root` constructor / config-file option, default
`<store>-backups` next to the store (`/data/okdb` → `/data/okdb-backups`). `destDir` is
relative to that root (default: a timestamped name); anything resolving outside it (`..`,
another absolute path, a symlink pointing out) is refused with `400 BACKUP_PATH_OUTSIDE_ROOT`,
an existing non-empty directory with `409 BACKUP_DEST_NOT_EMPTY`. The route is marked
destructive (it can fill the server's disk), so MCP clients must confirm it.

```javascript
new OKDB('/data/okdb', { backup: { root: '/mnt/backups/okdb' } });
```

---

## Logical backup workflow

A version-independent alternative to the hot backup (slower; re-derives indexes on import):

```javascript
// 1. Export type data
const json = await okdb.migrate.exportJSON({ pretty: false });
fs.writeFileSync('./backup/data.json', json);

// 2. Export blobs
await okdb.migrate.exportBlobs('./backup/blobs');

console.log('Backup complete');
```

Restore:

```javascript
// 1. Import type data
await okdb.migrate.importJSON(fs.readFileSync('./backup/data.json', 'utf8'));

// 2. Import blobs
await okdb.migrate.importBlobs('./backup/blobs');

// 3. Optional: verify integrity
const issues = await okdb.migrate.validateBlobIntegrity();
if (issues.length > 0) console.warn(issues);
```
