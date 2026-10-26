# Querying

OKDB provides a layered query model: fast synchronous reads by key, ordered range scans, index-narrowed scans, and MongoDB-style in-process filtering.

---

## Single record reads

```javascript
// Setup used by the examples on this page
await okdb.registerType('users');
await okdb.registerIndex('users', ['role']);
await okdb.registerIndex('users', ['role', 'createdAt']);
await okdb.put('users', 'alice', {
    name: 'Alice',
    role: 'admin',
    age: 41,
    active: true,
    createdAt: Date.now(),
    profile: { verified: true },
});
await okdb.put('users', 'bob', {
    name: 'Bob',
    role: 'member',
    age: 67,
    active: true,
    createdAt: Date.now(),
    profile: { verified: false },
});

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

Range scans return **lazy iterables** that read rows from LMDB in chunks as you iterate. `getRange` produces `{ key, value }` entries.

<!-- continues -->

```javascript
// All records in default order (key-lexicographic)
for (const { key, value } of okdb.getRange('users')) {
    console.log(key, value.name);
}

// Bounded range
for (const { key, value } of okdb.getRange('users', {
    start: 'a', // inclusive lower bound
    end: 'b', // EXCLUSIVE upper bound — 'b' itself is not returned
    limit: 100,
    reverse: false,
})) {
    console.log(key, value.name);
}
```

Convenience iterables for when you only need one dimension:

<!-- continues -->

```javascript
// Keys only
for (const key of okdb.getKeys('users')) console.log(key);

// Values only
for (const value of okdb.getValues('users')) console.log(value.name);

// Lexicographic prefix
for (const { key, value } of okdb.getByPrefix('users', 'team:')) console.log(key, value);

// Record count (native cursor count — no values decoded, but it walks the type's keys)
const total = okdb.getCount('users');
```

:::warning Iterating across `await`
The default key-ordered scans — `getRange`, `getKeys`, `getValues`, `getByPrefix`, and `query()` without an index — read each chunk in a fresh read transaction and resume after the last key: you may `await` inside the loop and keep iterating. The trade-off is that consistency is **per row**, not a point-in-time snapshot — rows written while you are suspended may or may not appear.

The **pinned** scans — `byIndex`, `getIndex`, `query()` narrowed by an index, `getChanges`, and any range with `snapshot: true` — read from one point-in-time snapshot. Suspending mid-iteration (an `await` inside the loop) releases it and the next step throws **`READER_HELD_ACROSS_AWAIT`**, deterministically. Either consume them synchronously, materialise first, or opt into `snapshot: 'tolerant'` on `getRange`/`getKeys`/`getValues`/`getChanges` (resume if no commit landed in the meantime, otherwise throw; index scans ignore it):

<!-- continues -->

```javascript
const all = Array.from(okdb.byIndex('users', ['role'], { prefix: ['admin'] }));
await new Promise((resolve) => setTimeout(resolve, 10));
// safe to use `all` here

try {
    for (const row of okdb.byIndex('users', ['role'])) {
        await new Promise((resolve) => setTimeout(resolve, 10)); // suspends mid-scan
    }
} catch (err) {
    console.log(err.code); // 'READER_HELD_ACROSS_AWAIT'
}
```

See [Upgrading to 2.1](upgrade-2.1.md) for the background.
:::

---

## MongoDB-style query

`query()` applies a MongoDB-style filter (the [sift](https://github.com/crcn/sift.js) operator set) over a range scan. It returns a lazy iterable of `{ key, value }` rows (spread it for an array); `limit`/`offset` count result rows, and `select: (row) => …` maps each row. Geo queries (`near`, `$near`, `$within`) return an Array.

Supported operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$regex` (+ `$options`), `$mod`, `$size`, `$all`, `$type`, `$elemMatch`, `$not`, `$and`, `$or`, `$nor`, plus dotted field paths.

**`$where` is not supported.** It evaluates code (a string compiled with `new Function`, or a function), so it is rejected everywhere a filter is accepted — `query()`/`count`, the HTTP query and count routes, FTS/vector post-filters, view definitions and subscription filters — at any nesting depth, with `QUERY_OPERATOR_FORBIDDEN` (HTTP 400). Filter in application code instead (e.g. `.filter()` over the results).

<!-- continues -->

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

<!-- continues -->

```javascript
// Only scans records where role === 'admin'
const adminsOver30 = okdb.query(
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
// query()'s own bound names differ from byIndex's (see below). start/end are NOT query()
// options: query() throws if you pass them.
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
`query()`'s options are a fixed vocabulary (`index`, `prefix`, `startIndex`, `endIndex`, `startKey`, `endKey`, `reverse`, `limit`, `offset`, `select`, `near`, `fts`, `vector`, `transaction`) — not a raw pass-through to the underlying range scan. Any other key throws immediately rather than being silently ignored: `start`/`end` (the byIndex/getRange names) with `query() does not support "start"/"end" …`, anything else with `query(): unrecognized option "<key>" … Allowed: …`, and an unknown key inside the nested `index: { fields, prefix, start, end, startKey, endKey }` form with `query(): unrecognized key "<key>" in options.index …`. `byIndex()` and `getRange()` reject unknown options with `UNKNOWN_RANGE_OPTION`.
:::

---

### Paging with `query()`

With `index`, page by primary key: pass the last row's `key` of the previous page as `startKey`. That row is skipped, and rows that
share its index key are paged correctly (several records with the same value never get lost or repeated at a page boundary). This
works forward and with `reverse: true`, and `endKey` stops before a key the same way.

```javascript
await okdb.ensureType('orders', { indexes: [['status', 'createdAt']] });
let last;
for (;;) {
    const page = Array.from(
        okdb.query(
            'orders',
            { status: 'open' },
            { index: ['status', 'createdAt'], limit: 50, ...(last ? { startKey: last } : {}) },
        ),
    );
    if (!page.length) break;
    // ... handle page ...
    last = page[page.length - 1].key;
}
```

`startIndex` / `endIndex` take index values instead: `startIndex` is inclusive, `endIndex` exclusive (append
`OKDBEnv.HIGH_SENTINEL` to include the last value), and they are always low / high, also with `reverse`. If the record named by
`startKey` has been deleted since the previous page, the scan finds no boundary and returns nothing; fall back to `startIndex`
from the last row's index values in that case.

## Index scans

`byIndex` iterates entries in index order, returning `{ key, value, version, indexKey }`. `indexKey` is the stored index key: the indexed field values followed by a trailing `null` sentinel (`['x', null]` for a one-field index, `['x', 3, null]` for two fields), as in 2.x.

```javascript
await okdb.ensureType('leaderboard', { indexes: [['score']] });
await okdb.ensureType('articles', { indexes: [['author'], ['author', 'publishedAt']] });
await okdb.put('leaderboard', 'p1', { name: 'Ada', score: 90 });
await okdb.put('articles', 'a1', { title: 'Hello', author: 'alice', publishedAt: Date.now() });

// All records in order of the 'score' field
for (const { key, value, indexKey } of okdb.byIndex('leaderboard', ['score'], { reverse: true, limit: 10 })) {
    console.log(key, value.name, indexKey[0]);
}

// Exact prefix match: all articles by author 'alice'
for (const { key, value } of okdb.byIndex('articles', ['author'], {
    prefix: ['alice'],
})) {
    console.log(key, value.title);
}

// Range on composite index: articles by 'alice' published in the last week
const since = Date.now() - 7 * 86400_000;
for (const { key, value } of okdb.byIndex('articles', ['author', 'publishedAt'], {
    start: ['alice', since],
    end: ['alice', Infinity],
})) {
    console.log(key, value.title);
}
```

### Options

| Option              | Type    | Description                                       |
| ------------------- | ------- | ------------------------------------------------- |
| `prefix`            | `any[]` | Index entries must start with these values        |
| `start`             | `any[]` | Inclusive lower bound (index key)                 |
| `end`               | `any[]` | Exclusive upper bound                             |
| `reverse`           | boolean | Scan in descending order                          |
| `limit`             | number  | Maximum entries to return                         |
| `offset`            | number  | Skip this many entries                            |
| `includeViolations` | boolean | For unique indexes: include all violating entries |

Bounds are written from field values alone, and `start` is inclusive while `end` is exclusive: `start: ['b', 1], end: ['b', 3]` returns the entries for `['b', 1]` and `['b', 2]`. To include the last value, append `OKDBEnv.HIGH_SENTINEL`: `end: ['b', 3, OKDBEnv.HIGH_SENTINEL]`. This holds identically for `reverse` (every entry ends in a `null` so a bound never equals a stored key). To page, resume after the last row with `start: [...lastValues, OKDBEnv.HIGH_SENTINEL]` (forward) or `end: lastValues` (backward), where `lastValues` is the row's `indexKey` without its trailing `null`.

`start`/`end` are always the lower/upper bound regardless of `reverse` — `byIndex`/`getIndex`/`countByIndex` swap them internally for a descending scan, so you never need to. Unrecognized option keys throw immediately rather than being silently ignored.

`getIndex` returns primary keys from the index sub-database (not full records) as a **lazy iterable**. Spread to an array if you need `.length`: `[...env.getIndex(...)]`.

---

## Counting index entries

`countByIndex` counts entries in an index range without loading any record data. It reads only the index sub-database — O(matching index entries), no record loads.

Pass `{start, end}` directly, same as `byIndex`. Use `OKDB.HIGH_SENTINEL` as the end bound for prefix scans:

```javascript
await okdb.ensureType('orders', { indexes: [['status'], ['status', 'createdAt']] });
await okdb.put('orders', 'o1', { status: 'pending', createdAt: Date.now() });

// Count orders with status === 'pending'
const n = okdb.countByIndex('orders', ['status'], {
    start: ['pending'],
    end: ['pending', OKDB.HIGH_SENTINEL],
});

// Compound index — count by first field prefix
const open = okdb.countByIndex('orders', ['status', 'createdAt'], {
    start: ['open'],
    end: ['open', OKDB.HIGH_SENTINEL],
});
```

**`countByIndex` vs `getCount`:**

- `getCount(type)` — total count, no filtering (native count over the type's keys).
- `countByIndex(type, index, {start, end})` — O(matching index entries), filtered count, no record loads.

---

## Hybrid queries

`query()` accepts `fts` and `vector` options to combine full-text search, semantic similarity, and index constraints in a single call. All signals compose — the result is a unified ranked list. The sift filter and index constraint are applied **while** the ranked candidates stream, so a selective filter still returns `limit` rows when that many matches pass.

### FTS signal

```javascript
// Setup for the FTS examples
await okdb.registerType('articles');
await okdb.registerIndex('articles', ['status']);
await okdb.fts.register('articles', 'articles_fts', { fields: ['title', 'body'] });
await okdb.put('articles', 'a1', {
    title: 'Database indexing basics',
    body: '...',
    status: 'published',
    category: 'tech',
});
await okdb.fts.flush('articles'); // wait until the write is searchable

// Full-text search — results ordered by BM25 relevance across ALL matches
const results = await okdb.query(
    'articles',
    {},
    {
        fts: { name: 'articles_fts', query: 'database indexing' },
        limit: 20,
    },
);
// Each result has: { key, value, version, score, ftsScore, numTerms, maxScore }
```

### FTS + index constraint

The index acts as a **hard constraint** — only documents present in the index range are returned. It does not affect ranking.

<!-- continues -->

```javascript
// FTS results, but only from published articles
const published = await okdb.query(
    'articles',
    {},
    {
        fts: { name: 'articles_fts', query: 'database indexing' },
        index: { fields: ['status'], prefix: ['published'] },
        limit: 20,
    },
);
```

### FTS + sift filter

The sift filter narrows the ranked FTS stream: candidates are pulled best-first until `limit` rows pass (or the matches run out), so a selective filter never starves the page:

<!-- continues -->

```javascript
const techOnly = await okdb.query(
    'articles',
    { category: 'tech' },
    {
        fts: { name: 'articles_fts', query: 'indexing' },
        limit: 20,
    },
);
```

### FTS + vector (hybrid semantic + keyword)

When both `fts` and `vector` are provided, candidates from each signal are combined and re-ranked using **Reciprocal Rank Fusion (RRF)**: `score = Σ weight / (60 + rank)`, each signal ranked within the rows that pass the filter/index constraint. RRF works across incomparable score scales — no normalization needed. `fts.weight` / `vector.weight` (default 1) tilt the fusion toward one signal.

<!-- not-runnable: needs an embeddings engine with an ML model -->

```javascript
const results = await okdb.query(
    'articles',
    {},
    {
        fts: { name: 'articles_fts', query: 'database' },
        vector: { engine: 'articles_vec', query: 'fast persistent storage', limit: 50, weight: 2 },
        limit: 20,
    },
);
// Each result has: { key, value, score (RRF), ftsScore?, vectorScore?, chunkHash?, chunk? }
```

Results are always **source documents**, one row per doc. For a chunked embeddings pipeline the
vector signal is collapsed per document (the best-scoring chunk decides `vectorScore`) and the
matched passage rides along as `chunkHash` plus `chunk: { start, end }` (character offsets into the
embedded field). `limit` counts documents, never chunks.

### Signal semantics

| Signal   | Ordering         | Can enumerate all matches | Notes                                 |
| -------- | ---------------- | ------------------------- | ------------------------------------- |
| `index`  | Field value      | Yes                       | Hard constraint only — never reorders |
| `fts`    | BM25 relevance   | Yes                       | Posting list intersection, BM25 top-k |
| `vector` | Similarity score | No — K-bounded            | ANN search, approximate               |

**Important:** `query()` returns a **Promise** (of an Array) when `fts` or `vector` is present (vector search requires async embedding inference). Without these options, `query()` returns synchronously.

### FTS options

| Option   | Type            | Default                                       | Description                                   |
| -------- | --------------- | --------------------------------------------- | --------------------------------------------- |
| `name`   | string          | required                                      | Registered FTS index name                     |
| `query`  | string          | `''`                                          | Text to search                                |
| `mode`   | `'and'`\|`'or'` | `'and'`                                       | AND: all terms required. OR: any term matches |
| `prefix` | boolean         | false                                         | Enable prefix matching on query tokens        |
| `limit`  | number          | all matches (200 when `query()` is unlimited) | Cap on raw FTS candidates considered          |
| `weight` | number          | 1                                             | RRF weight when fused with `vector`           |

### Vector options

| Option   | Type   | Default                      | Description                                  |
| -------- | ------ | ---------------------------- | -------------------------------------------- |
| `engine` | string | required                     | Vector search engine name                    |
| `query`  | string | required                     | Semantic query text                          |
| `limit`  | number | `max((limit+offset)×4, 100)` | ANN candidate pool size, in source documents |
| `weight` | number | 1                            | RRF weight when fused with `fts`             |

### Nested index form

The `index` option accepts a nested object for clarity:

```javascript
// Nested form (preferred for hybrid queries)
const nested = { index: { fields: ['status'], prefix: ['active'] } };

// Flat form (still works — backward compatible)
const flat = { index: ['status'], prefix: ['active'] };
```

---

## Geo query

OKDB has a built-in geospatial index based on geohash. Register a geo index on a field that stores a `{ lat, lon }` object (numbers, in degrees). Other shapes — e.g. an `[lat, lon]` array or GeoJSON — are not recognised and the document is silently left out of geo results:

```javascript
await okdb.registerType('places');
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

Internally, geohash prefix expansion covers the radius at the registered precision. Precision 7 gives ~153 m cells — good for neighbourhood/city-level queries. For ~5 m cells, use precision 9 (see the precision guide in [Indexes](./indexes.md#geo-indexes)).

---

## Range options reference

Most scan methods accept the same range options bag:

```typescript
{
    start?:   any;       // inclusive start key / index key
    end?:     any;       // EXCLUSIVE end key / index key
    limit?:   number;    // max entries returned
    offset?:  number;    // entries to skip
    reverse?: boolean;   // descending order
    prefix?:  any[];     // index prefix (byIndex / getIndex / countByIndex / query)
    snapshot?: boolean | 'tolerant'; // getRange / getKeys / getValues: pin one snapshot (see above)
}
```
