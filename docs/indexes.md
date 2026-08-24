# Indexes

Secondary indexes let you scan records by field values without touching every record. They are maintained atomically inside every write transaction — there is no window where an index is out of sync with the data.

---

## Registering an index

```javascript
// Single field
await okdb.registerIndex('articles', ['author']);

// Composite — multi-field
await okdb.registerIndex('articles', ['author', 'publishedAt']);

// Unique constraint
await okdb.registerIndex('users', ['email'], { unique: true });

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

```javascript
await okdb.indexReady('articles', ['author', 'publishedAt']);
```

Check status without waiting:

```javascript
okdb.getIndexStatus('articles', ['author']);
// → 'creating' | 'resetting' | 'ready'
```

---

## Dropping an index

```javascript
await okdb.dropIndex('articles', ['author', 'publishedAt']);
```

The index sub-database is deleted. Existing query code that references it will throw `OKDBIndexNotRegisteredError`.

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
await okdb.registerIndex('orders', ['customerId', 'createdAt']);

// All orders by customer 'c42', newest first
for (const { key, value } of okdb.byIndex('orders', ['customerId', 'createdAt'], {
    prefix:  ['c42'],
    reverse: true,
    limit:   50,
})) { ... }
```

The trailing `null` sentinel in the LMDB key format ensures that a prefix scan on `['c42']` correctly returns all entries for that customer regardless of their `createdAt` value.

---

## Counting without loading records

`countByIndex` counts matching index entries without touching the data store:

```javascript
await okdb.registerIndex('orders', ['status']);

const pending = okdb.countByIndex('orders', ['status'], {
    start: ['pending'],
    end: ['pending', OKDBEnv.HIGH_SENTINEL],
});

// Compound index
await okdb.registerIndex('orders', ['status', 'createdAt']);
const open = okdb.countByIndex('orders', ['status', 'createdAt'], {
    start: ['open'],
    end: ['open', OKDBEnv.HIGH_SENTINEL],
});
```

---

## Dot-notation for nested fields

Field paths can use dots to reach nested properties:

```javascript
await okdb.registerIndex('users', ['address.city']);

// Records where address.city === 'Paris'
for (const { key, value } of okdb.byIndex('users', ['address.city'], { prefix: ['Paris'] })) { ... }
```

---

## Unique indexes

A unique index prevents two records from having the same value for the indexed fields.

```javascript
await okdb.registerIndex('users', ['email'], { unique: true });

// This will throw OKDBUniqueConstraintError:
await okdb.put('users', 'user-2', { email: 'alice@example.com' }); // if 'alice@example.com' already exists
```

### Sync conflicts

When a duplicate arrives via sync (from another node), OKDB doesn't reject it — sync data is never lost. Instead, a **violation** is recorded, and a **winner** is deterministically chosen:

> Highest HLC timestamp wins. Ties broken by lexicographically largest `origin` node ID.

Violations are stored locally (not synced) and resolve automatically when the losing record is removed or updated.

```javascript
// List all violations for a type
const violations = okdb.getUniqueViolations('users');

// Check if any violations exist for a specific index
const hasProb = okdb.hasUniqueViolations('users', ['email']);

// Get a specific violation
const v = okdb.getUniqueViolation('users', ['email'], 'alice@example.com');
// v = { winner, entries, count, detectedAt, ... }
```

Events emitted:

```javascript
okdb.events.on('unique:violation', ({ type, index, indexKey, winner }) => { ... });
okdb.events.on('unique:violation_resolved', ({ type, index, indexKey }) => { ... });
```

:::note
Geo indexes cannot be unique. Geohash collisions make uniqueness semantics undefined — the registration will throw.
:::

---

## Geo indexes

Geospatial indexes use geohash encoding to map `{ lat, lon }` coordinates into a lexicographically ordered string space.

```javascript
await okdb.registerIndex('restaurants', ['coords'], { type: 'geo', precision: 7 });

await okdb.put('restaurants', 'r1', { name: 'Le Bistro', coords: { lat: 48.87, lon: 2.31 } });

// Radius search
const results = okdb.geoQuery('restaurants', 'coords', {
    lat:    48.87,
    lon:    2.31,
    radius: 1000,   // metres
});
for (const { key, value, distance } of results) { ... }
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
    ],
});
```

This registers the type if missing, registers each index if missing, and is safe to call on startup every time.
