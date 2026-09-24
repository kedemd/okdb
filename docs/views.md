# Materialized Views

Views are reactive, incrementally-maintained aggregations over a registered type. Every write to the source type is processed immediately and the result is always available synchronously via `.get()`. No polling, no background jobs, no query-time computation.

---

## Quick start

```js
const db = new OKDB('./mydb');
await db.open();
await db.registerType('orders');

const env = db.env('default');

// Create a view
await env.views.create('orderStats', {
    type: 'orders',
    filter: { status: 'completed' },
    reduce: {
        total: { $sum: 'amount' },
        count: { $count: true },
        avgValue: { $avg: 'amount' },
        byRegion: { $countBy: 'region' },
    },
});

// Read the live result — synchronous, O(1)
const stats = env.views.get('orderStats');
// → {
//     total:    { value: 142500 },
//     count:    { value: 312 },
//     avgValue: { value: 456.7 },
//     byRegion: { totalGroups: 2, preview: [{ key: 'EU', value: 140 }, { key: 'US', value: 172 }], hasMore: false, cursor: null }
//   }
```

---

## Definition shape

```js
{
    type:   string,      // required — source type (must be registered)
    filter: object,      // optional — sift-style filter applied before reducers
    map:    object,      // optional — declarative per-doc transform applied before reducers
    reduce: object,      // required, non-empty — output-field → reducer spec
}
```

### `filter`

Uses [sift](https://github.com/crcn/sift.js) query operators (MongoDB-style). Only documents that pass the filter contribute to the view.

```js
filter: { status: 'active', amount: { $gte: 100 } }
```

### `map`

A declarative transform merged onto each source document before reducers run. The original document fields are preserved — map fields are added/overwritten on top.

| Operator     | Syntax                                                          | Description                                                                   |
| ------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Field rename | `{ storeName: 'name' }`                                         | Copy field to output key; dot paths supported: `'address.city'`               |
| FK lookup    | `{ region: { $ref: ['regions', '$regionId', 'label'] } }`       | FK ref and target field both support dot paths                                |
| Concatenate  | `{ label: { $concat: ['$city', ' – ', '$name'] } }`             | `$`-prefixed tokens are field refs (dot paths ok); others are literals        |
| Coalesce     | `{ display: { $coalesce: ['$nickname', '$name', 'Unknown'] } }` | First non-null wins; `$`-prefixed tokens are field refs (dot paths supported) |

```js
// Example: enrich each store with its region name via a FK lookup,
// then group-count by that enriched field
map: {
    regionName: { $ref: ['regions', '$regionId', 'name'] },
},
reduce: {
    byRegion: { $countBy: 'regionName' },
}
```

### `reduce`

Each key in `reduce` becomes an output field. The value is a reducer spec:

| Reducer    | Spec                    | Output                                                      | Notes                                                                       |
| ---------- | ----------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| `$count`   | `{ $count: true }`      | `{ value: N }`                                              | Counts matching docs                                                        |
| `$sum`     | `{ $sum: 'field' }`     | `{ value: N }`                                              | Sums a numeric field; non-numeric values are ignored                        |
| `$avg`     | `{ $avg: 'field' }`     | `{ value: N }`                                              | Running average; `value` is `0` when no docs match                          |
| `$min`     | `{ $min: 'field' }`     | `{ value: X }`                                              | Index-backed: auto-creates an index on the field                            |
| `$max`     | `{ $max: 'field' }`     | `{ value: X }`                                              | Index-backed: auto-creates an index on the field                            |
| `$countBy` | `{ $countBy: 'field' }` | `{ totalGroups, preview: [{key, value}], hasMore, cursor }` | Groups docs by a field value — paginated, see [Output shape](#output-shape) |

Field paths in all reducers support dot notation for nested access: `{ $sum: 'metrics.revenue' }`, `{ $countBy: 'address.country' }`. This is consistent with how indexes handle nested fields.

`$min` and `$max` require an index on the named field. The view engine creates one automatically if none exists; it is removed when the view is removed (unless another consumer owns it).

---

## Output shape

`views.get(name)` returns an object with one key per entry in `reduce`. The shape depends on the reducer:

- **Scalar reducers** (`$count`, `$sum`, `$avg`, `$min`, `$max`): `{ value: N }`
- **Grouped reducers** (`$countBy`, `$group`): `{ totalGroups, preview: [...], hasMore, cursor }` — a paginated top-N of groups, not a plain `{ [groupKey]: ... }` map. `preview` entries are `{ key, value }` for `$countBy` and `{ key, <subReducerName>: { value } , ... }` for `$group`. By default `$countBy` sorts by count descending, capped at 50 groups; pass `{ preview: { limit, order, axis, cursor } }` to `get()` to page through the rest (`hasMore`/`cursor` mirror the next page).
- **`$ref` slots**: a nested object with the same shape as a top-level `reduce` result (see [$ref aggregations](#ref-aggregations))

```js
const result = env.views.get('orderStats');
result.total.value; // → 142500 (number)
result.avgValue.value; // → 456.7  (number)
result.byRegion.preview.find((e) => e.key === 'EU').value; // → 140 (number)
```

### `items: true`

Add `items: true` to any reducer spec to enable a `.items()` method on the result group. Calling it returns the live source documents that contribute to that aggregation bucket.

```js
reduce: {
    byRegion: { $countBy: 'region', items: true },
    total:    { $sum: 'amount', items: true },
}

// Access source docs for a specific group
const euOrders = result.byRegion.preview.find((e) => e.key === 'EU').items();  // → Order[]

// Scalar items() returns all matching docs
const allOrders = result.total.items();       // → Order[]
```

---

## `$group` reducer

`$group` partitions source documents by a field (or compound key) and runs named sub-reducers within each partition. The result is an object keyed by the group value, with each group holding a nested reduced document.

### Syntax

```js
reduce: {
    outputField: {
        $group: {
            by: 'field' | ['field1', 'field2'],  // group key — single field or compound
            filter: object,                       // optional — sift-style, applied within $group
            reduce: {
                subReducerName: { $count: true },
                revenue:        { $sum: 'amount' },
                avg:            { $avg: 'price' },
                // $countBy also works inside $group
            },
        },
    },
}
```

### Output shape

Like `$countBy`, the result is the paginated `{ totalGroups, preview, hasMore, cursor }` shape (see [Output shape](#output-shape) above) — not a plain `{ [groupKey]: {...} }` map. Each `preview` entry is `{ key, <subReducerName>: { value }, ... }`:

```js
{
    totalGroups: 2,
    preview: [
        { key: 'groupKey1', revenue: { value: 1200 }, count: { value: 4 } },
        { key: 'groupKey2', revenue: { value: 800 }, count: { value: 3 } },
    ],
    hasMore: false,
    cursor: null,
}
```

Empty groups (count/sum reaching 0) are removed automatically — they are never present as `{ value: 0 }`.

```js
const stats = env.views.get('orderStats');
const p1 = stats.byProduct.preview.find((e) => e.key === 'p1');
p1.revenue.value; // → 1200
p1.count.value; // → 4
```

### Compound key

Pass an array to `by` to build a key from multiple fields. The fields are joined with a `\x00` separator:

```js
$group: {
    by: ['product_id', 'region'],
    reduce: { count: { $count: true } },
}

// Key for product_id='p1', region='EU': 'p1\x00EU'
stats.byProductRegion.preview.find((e) => e.key === 'p1\x00EU').count.value;
```

### Filter semantics

Filters are evaluated at three levels:

| Level              | Where it lives                | What it filters                                                                  |
| ------------------ | ----------------------------- | -------------------------------------------------------------------------------- |
| View filter        | `definition.filter`           | Applied before map; docs failing it never reach any reducer                      |
| `$group.filter`    | `$group: { filter: {...} }`   | Applied within `$group`, post-map; docs failing it don't contribute to any group |
| Sub-reducer filter | Not supported inside `$group` | Sub-reducers within a group share the group's filter                             |

### Limitations

- `$min` and `$max` **work** inside `$group` (tracked per group key in the view's sorted sub-DB), but not inside a _nested_ `$group` — that throws `VIEW_NESTED_GROUP_INDEXED_UNSUPPORTED`; use a compound `by` array instead.
- `$ref` inside `$group.reduce` is not supported (`VIEW_GROUP_REF_UNSUPPORTED`) — use a top-level `$ref`.

### Example

```js
await env.views.create('lineItemStats', {
    type: 'line_items',
    reduce: {
        byProduct: {
            $group: {
                by: 'product_id',
                reduce: {
                    revenue: { $sum: 'amount' },
                    count: { $count: true },
                },
            },
        },
    },
});

const stats = env.views.get('lineItemStats');
// stats.byProduct.preview = [
//     { key: 'p1', revenue: { value: 1500 }, count: { value: 3 } },
//     { key: 'p2', revenue: { value:  800 }, count: { value: 2 } },
// ]
```

`$group` also works inside `$ref.reduce`:

```js
reduce: {
    lineItems: {
        $ref: {
            type: 'line_items',
            key: 'order_id',
            reduce: {
                byProduct: {
                    $group: {
                        by: 'product_id',
                        reduce: { total: { $sum: 'amount' } },
                    },
                },
            },
        },
    },
}

stats.lineItems.byProduct.preview.find((e) => e.key === 'p1').total.value; // → aggregate revenue for product p1
```

---

## Live map `$ref`

A map field with `live: true` on its `$ref` spec is a **live enrichment**: when the referenced document changes, all source documents pointing to it are automatically re-evaluated through the view.

### Syntax

```js
map: {
    vendorName: { $ref: ['vendors', '$vendor_id', 'name'], live: true },
}
```

The array form is identical to the snapshot `$ref` — the only difference is the `live: true` flag.

### Snapshot vs live semantics

| Mode                                | Behavior                                                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot (default, no `live: true`) | The referenced field is resolved once when the source doc is written. Later changes to the referenced doc are not reflected in the view.                                                                                          |
| Live (`live: true`)                 | OKDB maintains an inverse index mapping each referenced doc key to all source docs that point to it. When the referenced doc changes, every source doc in that fan-out set is re-processed through the filter, map, and reducers. |

```js
// Snapshot — p1's vendor change does NOT update the view
map: { vendor: { $ref: ['products', '$product_id', 'vendor'] } }

// Live — p1's vendor change re-evaluates all line_items with product_id='p1'
map: { vendor: { $ref: ['products', '$product_id', 'vendor'], live: true } }
```

### Cost considerations

Each live map field writes two extra sub-DBs per view:

- An **inverse index** (`liveMapInverse:<viewName>:<field>`) — maps each referenced doc key to the set of source doc keys that point to it.
- A **values cache** (`liveMapValues:<viewName>:<field>`) — caches the last resolved value per source doc to produce a correct `before` snapshot when the referenced doc changes.

When a referenced doc is updated, OKDB re-processes every source doc in the inverse index for that field. For a referenced type with many source documents per entry (high fan-out), this multiplies write cost:

- **Low fan-out** (e.g., a `products` table where each product has a few line items): `live: true` is fine.
- **High fan-out** (e.g., a `users` table where each user has thousands of events): prefer snapshot mode or move the enrichment to a materializer pipeline.

### Example

```js
await db.registerType('products');
await db.registerType('line_items');

await env.views.create('salesByVendor', {
    type: 'line_items',
    map: { vendor: { $ref: ['products', '$product_id', 'vendor'], live: true } },
    reduce: { byVendor: { $countBy: 'vendor' } },
});

await db.put('products', 'p1', { vendor: 'ACME' });
await db.put('line_items', 'li1', { product_id: 'p1', amount: 100 });
await db.put('line_items', 'li2', { product_id: 'p1', amount: 200 });

// salesByVendor.byVendor.preview → [{ key: 'ACME', value: 2 }]

await db.put('products', 'p1', { vendor: 'NewCo' }); // rename the vendor

// After propagation:
// salesByVendor.byVendor.preview → [{ key: 'NewCo', value: 2 }]
// ACME bucket is removed; both li1 and li2 moved to NewCo automatically.
```

---

## `$ref` aggregations

A `$ref` reducer aggregates documents from a _related_ type, scoped to the filtered parent documents. The child type must have a foreign-key field pointing back to the parent type's key.

```js
await env.views.create('storeStats', {
    type: 'stores',
    filter: { active: true },
    reduce: {
        storeCount: { $count: true },

        // Aggregate the related 'orders' type
        orders: {
            $ref: {
                type: 'orders', // child type
                key: 'storeId', // FK field on the child pointing to the parent key
                filter: { status: 'completed' },
                reduce: {
                    count: { $count: true },
                    revenue: { $sum: 'amount' },
                },
            },
        },
    },
});

const stats = env.views.get('storeStats');
stats.orders.count.value; // → total completed orders across all active stores
stats.orders.revenue.value; // → total revenue
```

`$ref` reducers support the same built-in reducers as top-level `reduce`, including `$min` and `$max`.

---

## Bucketing

Bucketed views partition their aggregations by a time period (or a custom grouping field), producing a per-bucket series of incremental results instead of a single global document.

### Bucket config

Add a `bucket` object to the view definition:

```js
{
    type:   string,     // source type (required)
    filter: object,     // optional
    reduce: object,     // required
    bucket: {
        field:       string,   // required — dot path to the timestamp or grouping field
        preset:      'time',   // use preset OR project, not both
        granularity: string,   // required — bucket size (see below)
    },
}
```

#### `preset: 'time'` granularities

| `granularity` | Bucket size          |
| ------------- | -------------------- |
| `minute`      | 1 minute             |
| `hour`        | 1 hour               |
| `day`         | 1 calendar day (UTC) |
| `week`        | ISO week             |
| `month`       | Calendar month       |
| `quarter`     | Calendar quarter     |
| `year`        | Calendar year        |

The `field` value is interpreted as a Unix timestamp in milliseconds or an ISO date string.

#### Custom projection (named)

To map each field value to an arbitrary string bucket key, register a projection function under a name with `OKDB.registerBucketProjection(name, fn)`, then reference that **name** in `bucket.project` (instead of `preset`):

```js
const OKDB = require('okdb');

// Once per process, BEFORE db.open():
OKDB.registerBucketProjection('lowercase', (value) => String(value ?? 'unknown').toLowerCase());

await env.views.create('byCategory', {
    type: 'products',
    reduce: { count: { $count: true } },
    bucket: { field: 'category', granularity: 'category', project: 'lowercase' },
});
```

- The stored (and synced) definition keeps the name, so the view recompiles on reopen, on peers and on `views.rebuild()`. Because the definition is plain JSON, a view that names a projection registered in the server process can also be created over HTTP.
- The registry is per process: **every process that opens the store must register the same name before `open()`**. A stored view whose projection isn't registered at `open()` is held back rather than failing the open: it is not activated, `views.get(name)` returns `null`, `views.getMeta(name)` reports `state: 'error'` with `error.code: 'BUCKET_PROJECT_UNKNOWN'`, and an error is logged. Register the name and call `views.rebuild(name)` to bring it back (a full re-derivation, since it missed writes while held back).
- Passing a function as `bucket.project` is refused with `BUCKET_PROJECT_NOT_PERSISTABLE` (it could not be stored); an unregistered name is refused with `BUCKET_PROJECT_UNKNOWN`.
- A projection that throws halts the view (see [States](#states)).

Stores that hold a view created with a function projection before this contract (its stored bucket has neither `preset` nor `project`) open normally; that view is held back with `BUCKET_CONFIG_INVALID` — remove it with `views.remove(name)` and re-create it with a registered name.

### Create example

```js
await env.views.create('salesByDay', {
    type: 'orders',
    filter: { status: 'completed' },
    reduce: {
        revenue: { $sum: 'amount' },
        count: { $count: true },
    },
    bucket: {
        field: 'completedAt', // Unix ms or ISO date string on each source doc
        preset: 'time',
        granularity: 'day',
    },
});
```

### `range(name, options?)` — per-bucket aggregates

Returns a sparse ordered array of bucket entries. Only buckets with at least one document appear.

```js
const rows = env.views.range('salesByDay', {
    from: '2024-01-01', // ISO date / epoch ms / Date — optional lower bound
    to: '2024-03-31', // inclusive upper bound — optional
    granularity: 'day', // must match the view's granularity, or omit
    includePartial: false, // true = include the bucket containing Date.now()
});
// → [
//     { bucketKey: '2024-01-01', granularity: 'day', reducers: { revenue: { value: 1200 }, count: { value: 4 } }, refs: {} },
//     { bucketKey: '2024-01-02', granularity: 'day', reducers: { revenue: { value: 890 },  count: { value: 3 } }, refs: {} },
//   ]
```

Each entry:

- `bucketKey` — canonical string key for the bucket (ISO date string for `preset:'time'`)
- `granularity` — the view's configured granularity
- `reducers` — `{ [outputField]: { value: N } }` for scalar reducers; `{ [outputField]: { totalGroups, preview: [{key, value}], hasMore, cursor } }` for `$countBy`/`$group`
- `refs` — `{ [refName]: { [subField]: { value: N } } }` for `$ref` sub-views

### `listBuckets(name, options)` — enumerate populated buckets

Returns an ordered list of bucket keys that have at least one document, with per-bucket counts.

```js
const buckets = env.views.listBuckets('salesByDay', {
    granularity: 'day', // required — must equal the view's configured granularity
    from: '2024-01-01', // optional
    to: '2024-12-31', // optional
    limit: 10, // optional — cap result count
    reverse: true, // optional — true = latest-first
});
// → [
//     { bucketKey: '2024-12-31', count: 5 },
//     { bucketKey: '2024-12-30', count: 12 },
//   ]
```

### Items scoped to a bucket

When a reducer has `items: true`, pass a `bucket` option to `.items()` to restrict results to a single bucket:

```js
const view = env.views.get('salesByDay');
const items = view.count.items({ bucket: { granularity: 'day', key: '2024-01-15' } });
// → Order[]  (only orders in the 2024-01-15 bucket)
```

---

## Lifecycle

### States

A view's meta state is available via `views.getMeta(name)`:

| State       | Meaning                                                                        |
| ----------- | ------------------------------------------------------------------------------ |
| `creating`  | Initial bootstrap scan in progress                                             |
| `ready`     | Fully up-to-date; all writes are being processed                               |
| `halted`    | A reducer threw; new writes are queued until the next write recovers the view  |
| `stopped`   | Manually paused; writes that arrive while stopped are replayed on start        |
| `resetting` | Clock regression detected; full rebuild triggered automatically                |
| `error`     | The stored definition could not be compiled at `open()` (held back, see below) |

A stored view that can't be compiled when the store opens — a custom reducer or bucket projection this process hasn't registered, a `$where` filter persisted before it was forbidden, a pre-named-projection bucket — never fails `open()`. That view alone is held back: it is not activated, `get()` returns `null`, `getMeta()` returns `{ state: 'error', error: { code, error } }`, and an error naming the view is logged. Every other view boots, rebuilds and serves normally, and `views.remove(name)` still works. `views.rebuild(name)` retries the compile (and fully re-derives the view on success).

### Rebuild

A full rebuild clears all accumulated state and re-scans the source type from scratch. Triggered automatically on clock regression; also available manually:

```js
await env.views.rebuild('orderStats');
```

### Stop / start

```js
await env.views.stop('orderStats'); // pause processing; definition is preserved
await env.views.start('orderStats'); // resume; catches up optimistically or rebuilds
```

When a view is stopped and later started:

- If no writes arrived while stopped, the view resumes instantly.
- If only _new_ documents were added (no modifications or removals), an optimistic catch-up is applied.
- Otherwise a full rebuild is performed.

### Remove

```js
await env.views.remove('orderStats');

// If the view owns an auto-created index, you must decide what happens to it:
await env.views.remove('orderStats', { managedIndexes: 'drop' }); // drop the index
await env.views.remove('orderStats', { managedIndexes: 'keep' }); // retain the index
```

---

## Custom reducers

Register a custom reducer before creating a view that uses it. Custom reducer names must start with `$` and must not be a built-in reducer name (`$count`, `$sum`, `$avg`, `$min`, `$max`, `$countBy`, `$group`) or `$ref` — those are refused with `VIEW_REDUCER_CONFLICT`. A view that references a `$name` no registered reducer matches is refused at `create()` with `VIEW_UNKNOWN_REDUCER`.

Reducers are referenced by name (the function isn't persisted), so register them in every process that opens the store. Prefer the process-wide `OKDB.registerViewReducer(name, { apply })`, called **before `db.open()`** — the stored view then compiles at boot and stays live from the first write. `env.views.registerReducer(name, { apply })` registers for one env after it is open; a stored view whose reducer is registered only that way is held back at `open()` (`getMeta` → `state: 'error'`, `error.code: 'VIEW_UNKNOWN_REDUCER'`) and is fully re-derived when `registerReducer` is called, so writes made in between are not lost.

```js
const product = {
    apply(state, before, after, opts) {
        // state  — current accumulated value (null on first call)
        // before — previous doc (null for inserts), post-filter, post-map
        // after  — new doc (null for deletes), post-filter, post-map
        // opts   — the value from the spec: { $product: opts }
        state = state ?? 1;
        if (before !== null && typeof before[opts] === 'number') state /= before[opts];
        if (after !== null && typeof after[opts] === 'number') state *= after[opts];
        return state;
    },
};
OKDB.registerViewReducer('$product', product); // before db.open()

await env.views.create('priceProduct', {
    type: 'items',
    reduce: { product: { $product: 'multiplier' } },
});
```

Documents that already exist when the view is created are folded in by the bootstrap scan, exactly as live writes are (`views.rebuild()` re-derives the same value). Custom reducers also work as `$group` and `$ref` sub-reducers. Views that use a custom reducer or projection bootstrap on the main thread (the off-thread bootstrap worker has no access to the in-process registries).

---

## JavaScript API

All methods are on `env.views` (`OKDBEnv#views`):

```js
const env = db.env('myEnv');

// Create
await env.views.create(name, definition)      // → { name }

// Read
env.views.get(name)                           // → output object | null  (synchronous)
env.views.getMeta(name)                       // → { state, clock, error, refs, storageVersion, ... } | null
await env.views.getDefinition(name)           // → stored definition | null
await env.views.list()                        // → string[]

// Bucketing (bucketed views only)
env.views.range(name, options?)               // → BucketEntry[] | null  (synchronous)
env.views.listBuckets(name, options)          // → { bucketKey, count }[]  (synchronous)
env.views.itemsGroups(name, opts)             // → one page of all groups of a grouped reducer

// Lifecycle
await env.views.rebuild(name)
await env.views.stop(name)
await env.views.start(name)
await env.views.remove(name, options?)

// Extension
env.views.registerReducer(name, { apply })    // per env; see Custom reducers
OKDB.registerViewReducer(name, { apply })     // process-wide, before open()
OKDB.registerBucketProjection(name, fn)       // process-wide, before open()
```

---

## HTTP API

Views are scoped per environment. The `{env}` segment is the environment name (e.g. `default`).

| Method   | Path                                     | Description                                      |
| -------- | ---------------------------------------- | ------------------------------------------------ |
| `GET`    | `/api/env/{env}/views`                   | List view names                                  |
| `POST`   | `/api/env/{env}/views`                   | Create a view                                    |
| `GET`    | `/api/env/{env}/views/{name}`            | Get current view output                          |
| `GET`    | `/api/env/{env}/views/{name}/meta`       | Get view state/meta                              |
| `GET`    | `/api/env/{env}/views/{name}/definition` | Get stored definition                            |
| `DELETE` | `/api/env/{env}/views/{name}`            | Remove a view                                    |
| `POST`   | `/api/env/{env}/views/{name}/rebuild`    | Rebuild from scratch                             |
| `POST`   | `/api/env/{env}/views/{name}/stop`       | Stop processing                                  |
| `POST`   | `/api/env/{env}/views/{name}/start`      | Start / resume                                   |
| `GET`    | `/api/env/{env}/views/{name}/range`      | Per-bucket aggregates (bucketed views only)      |
| `GET`    | `/api/env/{env}/views/{name}/buckets`    | List populated bucket keys (bucketed views only) |
| `POST`   | `/api/env/{env}/views/{name}/items`      | Paginated source items for a view or sub-scope   |

**Create body (standard view):**

```json
{
    "name": "orderStats",
    "type": "orders",
    "filter": { "status": "completed" },
    "reduce": {
        "total": { "$sum": "amount" },
        "count": { "$count": true }
    }
}
```

**Create body (bucketed view):**

```json
{
    "name": "salesByDay",
    "type": "orders",
    "filter": { "status": "completed" },
    "reduce": {
        "revenue": { "$sum": "amount" },
        "count": { "$count": true }
    },
    "bucket": {
        "field": "completedAt",
        "preset": "time",
        "granularity": "day"
    }
}
```

**Delete with managed indexes:**

```json
{ "managedIndexes": "drop" }
```

---

## MCP

Views are available as the `views` capability. Actions: `list_views`, `create_view`, `get_view`, `get_view_meta`, `get_view_definition`, `remove_view`, `rebuild_view`, `stop_view`, `start_view`, `get_view_range`, `list_view_buckets`, `list_view_items`.

---

## Views vs materializers

|                      | Views                                                       | Materializer engine                                                 |
| -------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| **What it produces** | A single reduced document (aggregates)                      | A populated target collection (projections)                         |
| **Definition style** | Declarative (`reduce`, `filter`, `map`)                     | Imperative function returning ops                                   |
| **Rebuild**          | `views.rebuild(name)`                                       | `engine.api.rebuild()`                                              |
| **Access**           | `env.views.get(name)` — always synchronous                  | Read the target type via `env.get(...)`                             |
| **Use when**         | You need live counters, sums, averages, or group statistics | You need a derived collection with one document per source document |

Use views for aggregations (how many, how much, grouped by). Use a materializer engine when you need a structurally transformed copy of a collection that other queries or features can read from directly.

See [pipelines.md](./pipelines.md) for materializer documentation.

---

## Sync behavior

View definitions are stored in the `~views` system type within their environment and sync to connected peers like any other document. On startup and after each sync reconcile pass, OKDB activates any view definitions that arrived from remote peers but are not yet live locally.

---

## Error codes

| Code                                    | Cause                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `VIEW_INVALID_NAME`                     | Name is empty, contains whitespace, or is not a string                                                |
| `VIEW_INVALID_DEFINITION`               | Definition is not an object                                                                           |
| `VIEW_MISSING_TYPE`                     | `type` field missing or not a string                                                                  |
| `VIEW_MISSING_REDUCE`                   | `reduce` field missing or empty                                                                       |
| `VIEW_TYPE_NOT_REGISTERED`              | The source type does not exist in this environment                                                    |
| `VIEW_ALREADY_EXISTS`                   | A view with that name already exists                                                                  |
| `VIEW_NOT_FOUND`                        | No view with that name                                                                                |
| `VIEW_HAS_ORPHANED_INDEXES`             | Removing the view would leave auto-created indexes with no owner; pass `managedIndexes` option        |
| `VIEW_GROUP_REF_UNSUPPORTED`            | `$ref` used as a sub-reducer inside `$group`                                                          |
| `VIEW_NESTED_GROUP_INDEXED_UNSUPPORTED` | `$min`/`$max` inside a nested `$group`                                                                |
| `VIEW_INVALID_REDUCER_NAME`             | Custom reducer name does not start with `$`                                                           |
| `VIEW_REDUCER_CONFLICT`                 | Custom reducer name conflicts with a built-in                                                         |
| `VIEW_INVALID_REDUCER`                  | Custom reducer missing an `apply` function                                                            |
| `BUCKET_CONFIG_INVALID`                 | `bucket` config is missing required fields, uses an unsupported preset, or has an invalid granularity |
| `BUCKET_INVALID_TIME_VALUE`             | A document's bucket field could not be parsed as a time value                                         |
| `VIEW_NOT_BUCKETED`                     | `range()` or `listBuckets()` was called on a view that has no `bucket` config                         |
| `VIEW_RANGE_GRANULARITY_MISMATCH`       | The `granularity` option does not match the view's configured granularity                             |
| `VIEW_RANGE_GRANULARITY_REQUIRED`       | `listBuckets()` was called without a `granularity` option                                             |
| `VIEW_ITEMS_SCOPE_INVALID`              | `scope` is not one of `view`, `reducer`, `ref`, `ref-reducer`                                         |
| `VIEW_ITEMS_REDUCER_NOT_FOUND`          | The named reducer does not exist on the view                                                          |
| `VIEW_ITEMS_REF_NOT_FOUND`              | The named `$ref` slot does not exist on the view                                                      |
| `VIEW_ITEMS_GROUP_NOT_FOUND`            | The named group key does not exist on the `$countBy` reducer                                          |
| `VIEW_ITEMS_NOT_AVAILABLE`              | `items()` was requested but the reducer does not have `items: true`                                   |
| `VIEW_ITEMS_LIMIT_INVALID`              | `limit` is not a non-negative integer                                                                 |
| `VIEW_ITEMS_OFFSET_INVALID`             | `offset` is not a non-negative integer                                                                |
