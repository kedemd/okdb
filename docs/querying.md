# Querying

OKDB provides a layered query model: fast synchronous reads by key, ordered range scans, index-narrowed scans, and MongoDB-style in-process filtering.

---

## Single record reads

```javascript
// Returns value or undefined
const user = okdb.get('users', 'alice');

// Returns { value, version } or undefined
const entry = okdb.getEntry('users', 'alice');

// Multiple keys at once — returns an array in the same order (undefined for missing)
const [alice, bob] = okdb.getMany('users', ['alice', 'bob']);
```

All reads are **synchronous**. LMDB maps the database file directly into process memory; there's no async I/O, no network call, no serialisation beyond a single decode.

---

## Range scans

Range scans return **lazy LMDB iterables**. They are cursor-backed and produce `{ key, value, version }` entries.

```javascript
// All records in default order (key-lexicographic)
for (const { key, value } of okdb.getRange('users')) {
    console.log(key, value.name);
}

// Bounded range
for (const { key, value } of okdb.getRange('users', {
    start: 'a',   // inclusive lower bound
    end:   'b',   // inclusive upper bound
    limit: 100,
    reverse: false,
})) { ... }
```

Convenience iterables for when you only need one dimension:

```javascript
// Keys only
for (const key of okdb.getKeys('users')) { ... }

// Values only
for (const value of okdb.getValues('users')) { ... }

// Lexicographic prefix
for (const { key, value } of okdb.getByPrefix('users', 'team:')) { ... }

// Record count (no scan — read from index metadata)
const total = okdb.getCount('users');
```

:::warning Cursor invalidation
Lazy iterables are invalidated the moment a write transaction opens on the same environment. If you `await` anything between iterating and finishing the cursor, materialise first:

```javascript
const all = Array.from(okdb.getValues('users'));
await doSomethingAsync();
// safe to use `all` here
```

:::

---

## MongoDB-style query

`query()` applies a [sift](https://github.com/crcn/sift.js) filter over a range scan. Sift supports the full MongoDB query operator syntax.

```javascript
// Basic equality
const admins = okdb.query('users', { role: 'admin' });

// Comparison operators
const seniors = okdb.query('users', { age: { $gte: 65 } });

// $in / $nin
const staff = okdb.query('users', { role: { $in: ['admin', 'moderator'] } });

// Nested fields
const verified = okdb.query('users', { 'profile.verified': true });

// Logical operators
const results = okdb.query('users', {
    $and: [{ role: 'member' }, { createdAt: { $gt: Date.now() - 7 * 86400_000 } }],
});
```

### Narrowing with an index

Without an index hint, `query()` scans every record. With one, it uses the index to iterate only matching entries:

```javascript
// Only scans records where role === 'admin'
const admins = okdb.query(
    'users',
    { role: 'admin', age: { $gte: 30 } },
    {
        index: ['role'],
        prefix: ['admin'],
    },
);

// With composite index: role + createdAt
const recent = okdb.query(
    'users',
    { active: true },
    {
        index: ['role', 'createdAt'],
        prefix: ['admin'],
        reverse: true,
        limit: 20,
    },
);

// Arbitrary (non-prefix) range on an index: use startIndex/endIndex, not start/end —
// query()'s own bound names differ from byIndex's (see below). Passing start/end here
// throws, pointing you at the right names, instead of silently scanning everything.
const weekAgo = Date.now() - 7 * 86400_000;
const recentAdmins = okdb.query(
    'users',
    {},
    {
        index: ['role', 'createdAt'],
        startIndex: ['admin', weekAgo],
        endIndex: ['admin', Infinity],
    },
);
```

:::tip
There is no query planner. If you pass `index`, OKDB uses it without cost analysis. Pick the most selective index for your query by hand.
:::

:::warning Unrecognized options throw
`query()`'s options are a fixed, invented vocabulary (`index`, `prefix`, `startIndex`, `endIndex`, `startKey`, `endKey`, `reverse`, `limit`, `offset`, `select`, `near`, `fts`, `vector`) — not a raw pass-through to the underlying range scan. Passing anything else, including the byIndex/getRange-style `start`/`end`, throws immediately rather than silently ignoring the key and scanning unfiltered.
:::

---

## Index scans

`byIndex` iterates entries in index order, returning `{ key, value, version, indexKey }`.

```javascript
// All records in order of the 'score' field
for (const { key, value, indexKey } of okdb.byIndex('leaderboard', ['score'], { reverse: true, limit: 10 })) {
    console.log(key, value.name, indexKey[0]);
}

// Exact prefix match: all articles by author 'alice'
for (const { key, value } of okdb.byIndex('articles', ['author'], {
    prefix: ['alice'],
})) { ... }

// Range on composite index: articles by 'alice' published in the last week
const since = Date.now() - 7 * 86400_000;
for (const { key, value } of okdb.byIndex('articles', ['author', 'publishedAt'], {
    start:  ['alice', since],
    end:    ['alice', Infinity],
})) { ... }
```

### Options

| Option              | Type    | Description                                       |
| ------------------- | ------- | ------------------------------------------------- |
| `prefix`            | `any[]` | Index entries must start with these values        |
| `start`             | `any[]` | Inclusive lower bound (full index key)            |
| `end`               | `any[]` | Inclusive upper bound                             |
| `reverse`           | boolean | Scan in descending order                          |
| `limit`             | number  | Maximum entries to return                         |
| `offset`            | number  | Skip this many entries                            |
| `includeViolations` | boolean | For unique indexes: include all violating entries |

`start`/`end` are always the lower/upper bound regardless of `reverse` — `byIndex`/`getIndex`/`countByIndex` swap them internally for a descending scan, so you never need to. Unrecognized option keys throw immediately rather than being silently ignored.

`getIndex` returns primary keys from the index sub-database (not full records) as a **lazy iterable**. Spread to an array if you need `.length`: `[...env.getIndex(...)]`.

---

## Counting index entries

`countByIndex` counts entries in an index range without loading any record data. It reads only the index sub-database — O(matching index entries), no record loads.

Pass `{start, end}` directly, same as `byIndex`. Use `OKDBEnv.HIGH_SENTINEL` as the end bound for prefix scans:

```javascript
// Count orders with status === 'pending'
const n = okdb.countByIndex('orders', ['status'], {
    start: ['pending'],
    end: ['pending', OKDBEnv.HIGH_SENTINEL],
});

// Compound index — count by first field prefix
const open = okdb.countByIndex('orders', ['status', 'createdAt'], {
    start: ['open'],
    end: ['open', OKDBEnv.HIGH_SENTINEL],
});
```

**`countByIndex` vs `getCount`:**

- `getCount(type)` — O(1), total count, no filtering.
- `countByIndex(type, index, {start, end})` — O(matching index entries), filtered count, no record loads.

---

## Hybrid queries

`query()` accepts `fts` and `vector` options to combine full-text search, semantic similarity, and index constraints in a single call. All signals compose — the result is a unified ranked list with sift post-filtering applied last.

### FTS signal

```javascript
// Full-text search — returns results ordered by relevance score
const results = await okdb.query(
    'articles',
    {},
    {
        fts: { name: 'articles_fts', query: 'database indexing' },
        limit: 20,
    },
);
// Each result has: { key, value, ftsScore, numTerms, maxScore }
```

### FTS + index constraint

The index acts as a **hard constraint** — only documents present in the index range are returned. It does not affect ranking.

```javascript
// FTS results, but only from published articles
const results = await okdb.query(
    'articles',
    {},
    {
        fts: { name: 'articles_fts', query: 'database indexing' },
        index: { fields: ['status'], prefix: ['published'] },
        limit: 20,
    },
);
```

### FTS + sift post-filter

Sift filter is always applied last, after FTS and index narrowing:

```javascript
const results = await okdb.query(
    'articles',
    { category: 'tech' },
    {
        fts: { name: 'articles_fts', query: 'indexing' },
        limit: 20,
    },
);
```

### FTS + vector (hybrid semantic + keyword)

When both `fts` and `vector` are provided, candidates from each signal are combined and re-ranked using **Reciprocal Rank Fusion (RRF)**. RRF works across incomparable score scales — no normalization needed.

```javascript
const results = await okdb.query(
    'articles',
    {},
    {
        fts: { name: 'articles_fts', query: 'database' },
        vector: { engine: 'articles_vec', query: 'fast persistent storage', limit: 50 },
        limit: 20,
    },
);
// Each result has: { key, value, score (RRF), ftsScore?, vectorScore? }
```

### Signal semantics

| Signal   | Ordering         | Can enumerate all matches | Notes                                 |
| -------- | ---------------- | ------------------------- | ------------------------------------- |
| `index`  | Field value      | Yes                       | Hard constraint only — never reorders |
| `fts`    | Relevance score  | Yes                       | Posting list intersection             |
| `vector` | Similarity score | No — K-bounded            | ANN search, approximate               |

**Important:** `query()` returns a **Promise** when `fts` or `vector` is present (vector search requires async embedding inference). Without these options, `query()` remains synchronous.

### FTS options

| Option   | Type            | Default              | Description                                   |
| -------- | --------------- | -------------------- | --------------------------------------------- |
| `name`   | string          | required             | Registered FTS index name                     |
| `query`  | string          | `''`                 | Text to search                                |
| `mode`   | `'and'`\|`'or'` | `'and'`              | AND: all terms required. OR: any term matches |
| `prefix` | boolean         | false                | Enable prefix matching on last token          |
| `limit`  | number          | `max(limit×10, 200)` | FTS candidate pool size                       |

### Vector options

| Option   | Type   | Default             | Description               |
| -------- | ------ | ------------------- | ------------------------- |
| `engine` | string | required            | Vector search engine name |
| `query`  | string | required            | Semantic query text       |
| `limit`  | number | `max(limit×4, 100)` | ANN candidate pool size   |

### Nested index form

The `index` option accepts a nested object for clarity:

```javascript
// Nested form (preferred for hybrid queries)
{ index: { fields: ['status'], prefix: ['active'] } }

// Flat form (still works — backward compatible)
{ index: ['status'], prefix: ['active'] }
```

---

## Geo query

OKDB has a built-in geospatial index based on geohash. Register a geo index on a field that stores `{ lat, lon }` (or an `[lat, lon]` array):

```javascript
await okdb.registerIndex('places', ['location'], { type: 'geo', precision: 7 });

// Store records with lat/lon
await okdb.put('places', 'eiffel', { name: 'Eiffel Tower', location: { lat: 48.8584, lon: 2.2945 } });

// Radius query — returns records within N metres of a point
const nearby = okdb.geoQuery('places', 'location', {
    lat: 48.8566,
    lon: 2.3522,
    radius: 5000, // metres
});
for (const { key, value, distance } of nearby) {
    console.log(value.name, Math.round(distance), 'm');
}
```

Internally, geohash prefix expansion covers the radius at the registered precision. Precision 7 gives ~76m cell size — good for city-level queries. For sub-10m accuracy, use precision 9.

---

## Range options reference

Most scan methods accept the same range options bag:

```typescript
{
    start?:   any;       // inclusive start key / index key
    end?:     any;       // inclusive end key / index key
    limit?:   number;    // max entries returned
    offset?:  number;    // entries to skip
    reverse?: boolean;   // descending order
    prefix?:  any[];     // index prefix (byIndex / query only)
}
```
