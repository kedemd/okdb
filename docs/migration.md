# Migration & Export

OKDB's migration feature handles export/import of all types and records as JSON, plus blob export/import for file storage, and blob integrity tools.

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

## Full backup workflow

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
