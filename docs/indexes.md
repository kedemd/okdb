# Indexes

Secondary indexes let you scan records by field values without touching every record. They are maintained atomically inside every write transaction — there is no window where an index is out of sync with the data.

---

## Registering an index

```javascript
await okdb.registerType('articles');
await okdb.registerType('users');
await okdb.registerType('places');

// Single field
await okdb.registerIndex('articles', ['author']);

// Composite — multi-field
await okdb.registerIndex('articles', ['author', 'publishedAt']);

// Unique constraint
await okdb.registerIndex('users', ['email'], { unique: true });

// Sparse — only records that have every indexed field
await okdb.registerType('things');
await okdb.registerIndex('things', ['facet', 'weight'], { sparse: true });

// Geospatial
await okdb.registerIndex('places', ['location'], { type: 'geo', precision: 7 });
```

### MCP note

Index management is exposed through the grouped `okdb_index` MCP tool.
Use `action: "create"` and send either the canonical `index` string or the convenience `fields` array.

```json
{
    "name": "okdb_index",
    "arguments": {
        "action": "create",
        "env": "default",
        "type": "places",
        "fields": ["location"],
        "indexType": "geo",
        "precision": 7
    }
}
```

For geo indexes, the indexed field should hold a single object shaped like `{ lat, lon }`.
That means the correct field path is usually `location`, not `location.lat` + `location.lon` as separate fields.

Indexes build **asynchronously** from existing data after registration. Writes during the build are tracked and the index converges to READY. To wait for completion:

<!-- continues -->

```javascript
await okdb.indexReady('articles', ['author', 'publishedAt']);
```

Check status without waiting:

<!-- continues -->

```javascript
okdb.getIndexStatus('articles', ['author']);
// → 'creating' | 'resetting' | 'waiting' | 'ready' | 'dropping' | 'error'
//   ('error' = the build failed; indexReady() rejects instead of hanging, the next reset/open retries)
```

---

## Dropping an index

<!-- continues -->

```javascript
await okdb.dropIndex('articles', ['author', 'publishedAt']);
```

The index sub-database is deleted. Existing query code that references it will throw an error with `code: 'INDEX_NOT_REGISTERED'` (`name: 'OKDBIndexNotRegisteredError'`).

---

## Index names

Internally, an index is identified by its fields joined with `~`:

```
['author']               → "author"
['author', 'publishedAt'] → "author~publishedAt"
['status', 'priority', 'when'] → "status~priority~when"
```

You rarely need to deal with index names directly — all API methods accept `string[]` and normalise for you.

---

## Composite indexes

A composite index orders records by the first field, then the second within ties, and so on. This mirrors SQL's multi-column index semantics.

```javascript
await okdb.registerType('orders');
await okdb.registerIndex('orders', ['customerId', 'createdAt']);
await okdb.put('orders', 'o1', { customerId: 'c42', createdAt: Date.now() });

// All orders by customer 'c42', newest first
for (const { key, value } of okdb.byIndex('orders', ['customerId', 'createdAt'], {
    prefix: ['c42'],
    reverse: true,
    limit: 50,
})) {
    console.log(key, value.createdAt);
}
```

A prefix scan on `['c42']` returns all entries for that customer regardless of their `createdAt` value.

---

## Counting without loading records

`countByIndex` counts matching index entries without touching the data store. It takes `start`/`end` (end exclusive — hence the `HIGH_SENTINEL` bound below) or, equivalently, `prefix`:

```javascript
await okdb.registerType('orders');
await okdb.registerIndex('orders', ['status']);

const pending = okdb.countByIndex('orders', ['status'], {
    start: ['pending'],
    end: ['pending', OKDB.HIGH_SENTINEL],
});

// Compound index
await okdb.registerIndex('orders', ['status', 'createdAt']);
const open = okdb.countByIndex('orders', ['status', 'createdAt'], {
    start: ['open'],
    end: ['open', OKDB.HIGH_SENTINEL],
});

// Same count, prefix form
const open2 = okdb.countByIndex('orders', ['status', 'createdAt'], { prefix: ['open'] });
```

---

## Dot-notation for nested fields

Field paths can use dots to reach nested properties:

```javascript
await okdb.registerType('users');
await okdb.registerIndex('users', ['address.city']);
await okdb.put('users', 'u1', { name: 'Ada', address: { city: 'Paris' } });

// Records where address.city === 'Paris'
for (const { key, value } of okdb.byIndex('users', ['address.city'], { prefix: ['Paris'] })) {
    console.log(key, value.name);
}
```

---

## Unique indexes

A unique index prevents two records from having the same value for the indexed fields.

```javascript
await okdb.registerType('users');
await okdb.registerIndex('users', ['email'], { unique: true });
await okdb.put('users', 'user-1', { email: 'alice@example.com' });

try {
    await okdb.put('users', 'user-2', { email: 'alice@example.com' });
} catch (err) {
    console.log(err.code); // 'UNIQUE_CONSTRAINT' (name: 'OKDBUniqueConstraintError')
}
```

### Sync conflicts

When a duplicate arrives via sync (from another node), OKDB doesn't reject it — sync data is never lost. Instead, a **violation** is recorded, and a **winner** is deterministically chosen:

> Highest HLC timestamp wins. Ties broken by lexicographically largest `origin` node ID.

Violations are stored locally (not synced) and resolve automatically when the losing record is removed or updated.

<!-- continues -->

```javascript
// List all violations for a type (optionally for one index: getUniqueViolations('users', ['email']))
const violations = okdb.getUniqueViolations('users');

// Check if any violations exist for a specific index
const hasProb = okdb.hasUniqueViolations('users', ['email']);

// Get a specific violation (null when there is none)
const v = okdb.getUniqueViolation('users', ['email'], 'alice@example.com');
// v = { winner, entries, count, detectedAt, ... }
```

Events emitted:

```javascript
okdb.events.on('unique:violation', ({ type, index, indexKey, winner }) => {
    console.log('duplicate', type, index, indexKey, 'winner:', winner);
});
okdb.events.on('unique:violation_resolved', ({ type, index, indexKey }) => {
    console.log('resolved', type, index, indexKey);
});
```

:::note
Geo indexes cannot be unique. Geohash collisions make uniqueness semantics undefined — the registration throws `INVALID_INDEX_OPTIONS`.
:::

---

## Sparse indexes

By default an index holds **every** record of its type. A record that lacks an indexed field is still entered, with `null` in
that position, so `{ facet: 'x' }` appears in an index on `['facet', 'weight']` under the key `['x', null]`. That keeps the
index complete, but when a type has many indexes and most records only carry a few of the fields, every write pays for index
entries nobody will ever query.

A **sparse** index leaves those records out: a record gets an entry only if it has a non-null value for **every** field of the
index.

```javascript
await okdb.registerType('things');
await okdb.registerIndex('things', ['facet', 'weight'], { sparse: true });

await okdb.put('things', 'a', { facet: 'x', weight: 3 }); // indexed
await okdb.put('things', 'b', { facet: 'x' }); // no `weight`: not in this index
await okdb.put('things', 'c', { facet: 'x', weight: null }); // null counts as missing: not in this index

[...okdb.byIndex('things', ['facet', 'weight'])].length; // 1
```

**When to use it.** Many indexes on one type, each covering fields that only some records have (a "facet"/attribute style
model). Writes get cheaper — a type with 110 such indexes went from about 0.6 ms to 0.2 ms of CPU per put — and the index
files shrink.

**What you give up.** A record missing a field never shows up in `byIndex`, `getIndex`, counts or prefix scans on that
index — you cannot ask a sparse index for "records where this field is missing". Use a regular index if you need that.
Everything else is unchanged: a record that gains the field enters the index on its next write, one that loses it leaves,
and removing a record removes its entry.

**Rules.**

- Chosen when the index is registered and fixed afterwards. To change it, drop the index and register it again.
- Combines with `unique` (a unique index already ignores records with a null field, so `unique + sparse` only saves space).
- Not available on geo indexes — they already skip records without a location (`INVALID_INDEX_OPTIONS`).
- Shown as `sparse: true` in the index metadata (`getIndexMeta`, `GET .../indexes`), replicated to peers with the index, and kept
  by export/import. The admin UI shows a _sparse_ badge and a checkbox in _Create Index_.

---

## Geo indexes

Geospatial indexes use geohash encoding to map `{ lat, lon }` coordinates into a lexicographically ordered string space.

```javascript
await okdb.registerType('restaurants');
await okdb.registerIndex('restaurants', ['coords'], { type: 'geo', precision: 7 });

await okdb.put('restaurants', 'r1', { name: 'Le Bistro', coords: { lat: 48.87, lon: 2.31 } });

// Radius search
const results = okdb.geoQuery('restaurants', 'coords', {
    lat: 48.87,
    lon: 2.31,
    radius: 1000, // metres
});
for (const { key, value, distance } of results) {
    console.log(key, value.name, distance);
}
```

**Precision guide:**

| Precision | Cell size | Good for      |
| --------- | --------- | ------------- |
| 5         | ~4.9km    | Country-level |
| 6         | ~1.2km    | City-level    |
| 7         | ~153m     | Neighbourhood |
| 8         | ~38m      | Street        |
| 9         | ~5m       | Building      |

Higher precision = more storage, slower builds, higher accuracy.

---

## `ensureType` shorthand

The most concise way to set up a type with indexes in one call:

```javascript
await okdb.ensureType('products', {
    indexes: [
        ['category'],
        ['category', 'price'],
        { fields: ['location'], type: 'geo', precision: 6 },
        { fields: ['sku'], unique: true },
        { fields: ['category', 'discount'], sparse: true },
    ],
});
```

This registers the type if missing, registers each index if missing, and is safe to call on startup every time.
