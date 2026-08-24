# Transactions

OKDB supports two write styles: single-operation writes (the default) and explicit batch transactions. Both are fully atomic.

---

## Single-operation writes

Each of these creates and commits its own LMDB transaction internally:

```javascript
await okdb.put('orders', 'o1', { item: 'widget', qty: 3, status: 'pending' });
await okdb.create('orders', 'o2', { item: 'gadget', qty: 1, status: 'pending' });
await okdb.update('orders', 'o1', { item: 'widget', qty: 5, status: 'pending' });
await okdb.remove('orders', 'o1');
```

| Method   | Behaviour                                     |
| -------- | --------------------------------------------- |
| `put`    | Upsert — create or overwrite                  |
| `create` | Throws `OKDBAlreadyExistsError` if key exists |
| `update` | Throws `OKDBNotFoundError` if key absent      |
| `remove` | Throws `OKDBNotFoundError` if key absent      |

---

## Batch transactions

When you need multiple operations to succeed or fail together, use `okdb.transaction()`:

```javascript
const txn = okdb.transaction();

txn.put('accounts', 'alice', { balance: 900 });
txn.put('accounts', 'bob', { balance: 1100 });
txn.put('transfers', 'tx1', { from: 'alice', to: 'bob', amount: 100, ts: Date.now() });

await txn.commit(); // all three land in one LMDB write transaction
```

Rollback (discard without writing):

```javascript
txn.rollback();
```

### How it works

`OKDBTransaction` accumulates operations in memory. On `commit()`, it replays them all inside a single `okdb.db.transaction()` call. Every secondary index update and change-log entry for all operations is written atomically in that one transaction — there is no partial state.

---

## Optimistic concurrency

Guard writes with a version check using `ifVersion`:

```javascript
// Read the current version
const entry = okdb.getEntry('products', 'p42');
// entry.version = 7

// Only write if the record hasn't changed since we read it
await okdb.put(
    'products',
    'p42',
    { ...entry.value, stock: entry.value.stock - 1 },
    {
        ifVersion: entry.version, // throws OKDBVersionMismatchError if version changed
    },
);
```

This is a classic compare-and-swap. If another writer modified the record between your read and your write, the write throws and you can retry.

In a batch transaction:

```javascript
const txn = okdb.transaction();
txn.put('products', 'p42', newValue, { ifVersion: 7 });
txn.put('products', 'p43', newValue2);
await txn.commit(); // both succeed or both fail
```

---

## Error types

| Error                         | Code                   | Thrown by                  |
| ----------------------------- | ---------------------- | -------------------------- |
| `OKDBAlreadyExistsError`      | `ALREADY_EXISTS`       | `create()`                 |
| `OKDBNotFoundError`           | `NOT_FOUND`            | `update()`, `remove()`     |
| `OKDBVersionMismatchError`    | `VERSION_MISMATCH`     | any write with `ifVersion` |
| `OKDBUniqueConstraintError`   | `UNIQUE_CONSTRAINT`    | unique index violation     |
| `OKDBTypeNotRegisteredError`  | `TYPE_NOT_REGISTERED`  | write to unknown type      |
| `OKDBIndexNotRegisteredError` | `INDEX_NOT_REGISTERED` | query on unknown index     |

All errors extend `OKDBError` and carry a `code` property.

```javascript
const { OKDBError, OKDBVersionMismatchError } = require('okdb/okdb-error');

try {
    await okdb.put('products', 'p42', newValue, { ifVersion: oldVersion });
} catch (err) {
    if (err instanceof OKDBVersionMismatchError) {
        // retry logic
    } else {
        throw err;
    }
}
```

---

## HTTP API — bulk writes

The `/transaction` endpoint is the right tool for bulk ingest over HTTP. It accepts an array of operations and commits them all in a single LMDB transaction.

```bash
curl -X POST http://localhost:8080/api/default/transaction \
  -H "Authorization: Bearer my-token" \
  -H "Content-Type: application/json" \
  -d '{
    "operations": [
      { "action": "put", "type": "orders", "key": "o1", "value": { "item": "widget", "qty": 3 } },
      { "action": "put", "type": "orders", "key": "o2", "value": { "item": "gadget", "qty": 1 } },
      { "action": "put", "type": "orders", "key": "o3", "value": { "item": "doohickey", "qty": 5 } }
    ]
  }'
```

Each operation is `{ action, type, key, … }`:

| `action` | Extra fields                    | Notes                                   |
| -------- | ------------------------------- | --------------------------------------- |
| `put`    | `value` (required), `ifVersion` | Upsert — create or overwrite            |
| `update` | `value` (required), `ifVersion` | Throws if key absent                    |
| `patch`  | `patch` (required), `ifVersion` | Same patch format as `PATCH /item/:key` |
| `remove` | `ifVersion`                     | Throws if key absent                    |

The body can also be sent as a bare array (omitting the `operations` wrapper):

```bash
curl -X POST http://localhost:8080/api/default/transaction \
  -H "Authorization: Bearer my-token" \
  -H "Content-Type: application/json" \
  -d '[
    { "action": "put", "type": "prices", "key": "sku-001", "value": { "price": 9.99 } },
    { "action": "put", "type": "prices", "key": "sku-002", "value": { "price": 19.99 } }
  ]'
```

Responds `204 No Content` on success. If any operation fails validation, the entire transaction is aborted and nothing is written.

---

## Timestamp and origin

Every write accepts a `timestamp` and `origin` option used by the sync system:

```javascript
await okdb.put('items', 'i1', value, {
    timestamp: Date.now(), // used for LWW conflict resolution
    origin: 'node-uuid-...', // prevents echo-loops in sync
});
```

You rarely need to set these manually — they are used internally by the sync feature.

---

## What's atomic

Everything that happens inside a single `db.transaction()` call is atomic:

1. Primary data written to `type:T:data`
2. All secondary index entries updated (`type:T:index:I` sub-dbs)
3. Clock incremented and change log entries written (`clocks`, `changes`, `clockToChange`, `keyToChange`)

No partial state is ever visible. If the process crashes mid-write, LMDB rolls back the transaction on the next open.

Post-commit events (`item:create`, `system:clock_change`, etc.) fire **after** the LMDB transaction has been durably committed — never speculatively.

---

## FTS and read-your-writes consistency

FTS writes are **always async** — the FTS index is updated by a background processor after each write commits. Secondary indexes (field indexes, geo indexes) are updated synchronously inside the same LMDB transaction as the write, so they are immediately consistent.

For applications that require read-your-writes consistency after a write, use `fts.flush(type)`:

```javascript
await okdb.put('articles', 'a1', { title: 'Hello world' });
await okdb.fts.flush('articles'); // wait for processor to index the write
const results = okdb.fts.search('articles', 'main', 'hello'); // guaranteed to include a1
```

`fts.flush()` is a no-op if the processor is already caught up. It is safe to call unconditionally. In addition to waiting for the processor, `flush()` runs the FTS compactor — rolling live-tier entries into the compacted Roaring bitmap tier — so search performance and storage stay stable under bursty writes. See [Full-Text Search](./fts.md) for the storage architecture.
