# Getting Started

## Installation

OKDB is a private package. Reference it from its local path or your monorepo:

```bash
npm install /path/to/okdb
# or in package.json:
# "okdb": "file:../okdb"
```

Dependencies that OKDB needs internally (`lmdb`, `sift`, `hnswlib-node`, etc.) are all declared in its own `package.json` and will install automatically.

---

## Opening a database

```javascript
const OKDB = require('@kedem/okdb');

const okdb = new OKDB('./mydb', options);
await okdb.open();

// ... use the database ...

await okdb.close();
```

The path is the root directory. OKDB creates subdirectories inside it for each environment (`default/`, `~system/`, etc.). If the directory doesn't exist it will be created.

### Constructor options

```javascript
const okdb = new OKDB('./mydb', {
    // Durability preset: 'strict' | 'balanced' (default) | 'fast'
    // 'balanced' enables overlappingSync for throughput without losing crash safety
    // 'fast' disables fsync — fastest writes, data loss risk on OS crash
    durability: 'balanced',

    // LMDB map size in bytes (default 4 GiB — grows automatically)
    mapSize: 4 * 1024 ** 3,

    // LZ4 compression on values (default true)
    compression: true,

    // AES-256 encryption key (optional)
    encryptionKey: undefined,

    // HTTP server options
    api: {
        tokens: ['my-bearer-token'], // Bearer tokens for API auth
    },
    admin: {
        auth: {
            user: 'admin',
            pass: 'secret',
            cookieSecret: 'change-me',
            cookieTtlMs: 3_600_000,
        },
    },
    sync: {
        token: 'cluster-secret',
        address: 'http://localhost:8080', // this node's public address
    },

    // Role flags (okdb 2.0) — what background work THIS process runs.
    // All default to true; a plain `new OKDB(path)` is a full do-everything node.
    // `processors` is the INITIAL participation only — okdb.processors.start()/stop()
    // flip it at runtime (open with false + start() later = fast startup).
    processors: true, // claim processor leases and drain derived work (FTS, views, …)
    engines: true, // run embeddings / vector-search engines
    compaction: true, // eligible to claim the per-env compaction lease
});
```

See [Roles & Deployment](./deployment.md) for what the role flags mean and how to run
multi-process topologies (N capable nodes, dedicated workers + passive serving nodes).

---

## Your first type

A **type** is OKDB's equivalent of a collection or table. Records in a type share the same secondary indexes and FTS indexes.

```javascript
await okdb.registerType('users');
```

`registerType` throws if the type already exists. Use `ensureType` for idempotent setup:

```javascript
await okdb.ensureType('users', {
    indexes: [['role'], ['email'], ['createdAt']],
});
```

---

## Writing records

```javascript
// Upsert — create or overwrite
await okdb.put('users', 'alice', { name: 'Alice', role: 'admin', email: 'alice@example.com', createdAt: Date.now() });

// Create — throws ALREADY_EXISTS if key exists
await okdb.create('users', 'bob', { name: 'Bob', role: 'member', email: 'bob@example.com', createdAt: Date.now() });

// Update — throws NOT_FOUND if key absent
await okdb.update('users', 'alice', {
    name: 'Alice',
    role: 'superadmin',
    email: 'alice@example.com',
    createdAt: Date.now(),
});

// Remove
await okdb.remove('users', 'alice');
```

:::note
All write methods return a Promise. The record is durable once the promise resolves.
:::

---

## Reading records

Reads are **synchronous** — no `await` needed.

```javascript
// Single record (returns value or undefined)
const user = okdb.get('users', 'bob');

// Single record with version metadata
const { value, version } = okdb.getEntry('users', 'bob');

// Multiple records at once
const [alice, bob] = okdb.getMany('users', ['alice', 'bob']);

// All keys in a type
for (const key of okdb.getKeys('users')) {
    console.log(key);
}

// All values
for (const value of okdb.getValues('users')) {
    console.log(value);
}

// Count (no full scan needed)
const count = okdb.getCount('users');
```

---

## Querying

MongoDB-style filters via [sift](https://github.com/crcn/sift.js):

```javascript
const admins = okdb.query('users', { role: 'admin' });
for (const { key, value } of admins) {
    console.log(key, value.name);
}

// Nested field conditions
const recent = okdb.query('users', {
    createdAt: { $gt: Date.now() - 86400_000 },
    role: { $in: ['admin', 'moderator'] },
});
```

:::tip
`query()` without an `index` option does a full scan filtered in-process. For large types, use an index to narrow the scan range first. See [Indexes](./indexes.md).
:::

---

## Starting the HTTP server

OKDB includes a built-in HTTP server with a REST API and admin UI:

```javascript
// Start listening
okdb.http.listen(8080);

console.log('API:   http://localhost:8080/api/type/users');
console.log('Admin: http://localhost:8080/admin/index.html');
```

The admin UI provides a browser-based data explorer, index manager, and real-time monitoring.

---

## Closing

Always close cleanly so processors drain and LMDB flushes properly:

```javascript
process.on('SIGINT', () => okdb.close().then(() => process.exit(0)));
process.on('SIGTERM', () => okdb.close().then(() => process.exit(0)));
```

---

## Full minimal example

```javascript
'use strict';
const OKDB = require('@kedem/okdb');

async function main() {
    const okdb = new OKDB('./demo');
    await okdb.open();

    await okdb.ensureType('products', {
        indexes: [['category'], ['price'], ['category', 'price']],
    });

    await okdb.put('products', 'p1', { name: 'Widget', category: 'tools', price: 9.99 });
    await okdb.put('products', 'p2', { name: 'Gadget', category: 'tools', price: 19.99 });
    await okdb.put('products', 'p3', { name: 'Doohickey', category: 'misc', price: 4.99 });

    // Query with filter
    const tools = okdb.query('products', { category: 'tools' });
    for (const { key, value } of tools) {
        console.log(`${key}: ${value.name} — $${value.price}`);
    }

    // Range scan by index
    const cheap = okdb.byIndex('products', ['price'], {
        start: [0],
        end: [10],
    });
    for (const { key, value } of cheap) {
        console.log(`${value.name} costs $${value.price}`);
    }

    await okdb.close();
}

main().catch(console.error);
```
