# Getting Started

## Installation

```bash
npm install @kedem/okdb
```

Requirements: **Node.js 18+ on Linux x64 with glibc 2.28 or newer** (Debian 10+, Ubuntu 18.10+, RHEL 8+, Amazon Linux 2023, ...).

okdb 3 is a native core (written in Rust) with a JavaScript API. The compiled core ships **inside** the package
(`node_modules/@kedem/okdb/native/linux-x64-gnu/`), so there is nothing to compile and no install script. The only JavaScript
dependencies are `msgpackr` and `sift`.

- npm refuses to install the package on other platforms (`EBADPLATFORM`: macOS, Windows, arm64). If it gets installed anyway
  (musl/Alpine, `--force`), `require('@kedem/okdb')` throws an error with `code: 'NATIVE_UNAVAILABLE'` that names the platform;
  `err.cause` holds the loader error when the native file exists but cannot load (for example an older glibc). Stay on okdb 2.x
  on those platforms for now.
- `OKDB_NATIVE_BINARY=/path/to/okdb-node.linux-x64-gnu.node` loads a specific native file instead of the bundled one (a missing
  file is an error, not a fallback). `OKDB_NATIVE_DEBUG=1` prints which file was loaded.

```js
const OKDB = require('@kedem/okdb');

console.log(OKDB.implementation); // 'native'
console.log(OKDB.nativeBinaryPath); // the .node file this process loaded
```

### The `okdb` command

The package also installs the `okdb` CLI: a standalone HTTP server with the admin UI, plus backup / restore / export / import,
tokens, licenses and health checks. It is a small native launcher that runs the CLI inside the same native file the library uses
(no Node.js needed to run it):

```bash
npx okdb --path ./mydb --port 8080      # serve ./mydb on :8080 (REST API + admin UI)
npx okdb --help                         # every command and option
npx okdb --okdb-which                   # where the native launcher lives
```

`npx okdb` goes through a tiny Node wrapper. Containers can run the launcher directly:
`node_modules/@kedem/okdb/native/linux-x64-gnu/okdb`.

---

## Opening a database

```javascript
const OKDB = require('@kedem/okdb');

const okdb = new OKDB('./mydb');
await okdb.open();

// ... use the database ...

await okdb.close();
```

The path is the root directory. OKDB creates subdirectories inside it for each environment (`default/`, `~system/`, etc.). If the directory doesn't exist it will be created.

### Constructor options

<!-- not-runnable: an annotated list of options, not a program -->

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

    // HTTP auth (REST API + admin UI) — see "Authentication" below
    auth: {
        // Open mode: trust these clients without a token. true = localhost only;
        // or an IP / CIDR / '*' string or array, e.g. ['127.0.0.1', '192.168.1.0/24'].
        // Default false = secure (every request needs a token). CLI: --open [ip ...]
        open: false,
        // Session tokens issued at login: HMAC secret (generated and persisted in the
        // store when unset) and TTL in ms
        token: { secret: undefined, ttl: 3_600_000 },
        session: { secure: false, sameSite: 'Lax' }, // session cookie flags
    },
    sync: {
        address: 'http://localhost:8080', // this node's public sync address
    },

    // Role flags — what background work THIS process runs.
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

### Authentication

There are no passwords or API keys in the constructor options: credentials are **tokens** stored
in the database (the `~tokens` type in `~system`, hashed).

- **Secure mode (the default).** Every HTTP request needs a token: send it as
  `Authorization: Bearer <token>`, or log in to the admin UI with a token's name + password.
- **Bootstrap window.** While `~tokens` is empty, only **localhost** is accepted (with full
  access) and every other client is refused — so a fresh node is usable locally but closed to
  the network until you create the first token.
- **Creating tokens.** From the CLI, with direct access to the store (no HTTP needed):

    ```bash
    okdb token create --name admin --password 's3cret' --permissions '*'
    okdb token create --label 'ci reader' --permissions 'data:read'   # prints the raw token once
    okdb token list
    okdb token revoke <id>
    ```

    or from the admin UI / `POST /api/auth/tokens` (from localhost during the bootstrap window, or
    as an admin).

- **Open mode** skips authentication for trusted clients: `auth: { open: true }` (localhost) or
  a list of IPs/CIDRs, `'*'` for everyone — the CLI's `--open [ip ...]`. okdb logs a warning at
  startup while it is on.

See [Auth & Sync](./auth-and-sync.md) and [Auth permissions](./auth-permissions.md) for the
permission model.

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

<!-- continues -->

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

<!-- continues -->

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

<!-- continues -->

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

<!-- not-runnable: starts a long-running server -->

```javascript
// Start listening
okdb.http.listen(8080);

console.log('API:   http://localhost:8080/api/');
console.log('Admin: http://localhost:8080/admin/');
```

The admin UI provides a browser-based data explorer, index manager, and real-time monitoring.

---

## Closing

Always close cleanly so processors drain and LMDB flushes properly:

<!-- not-runnable: installs process signal handlers -->

```javascript
process.on('SIGINT', () => okdb.close().then(() => process.exit(0)));
process.on('SIGTERM', () => okdb.close().then(() => process.exit(0)));
```

---

## The OKDB object at a glance

`require('@kedem/okdb')` exports the `OKDB` class (also as `.OKDB` and `.default`). Error classes are not exported: branch on
`err.code` (every okdb error is an `OKDBError` with a stable `code`, a message and `details`).

**Statics**

| Static                                                           | What it is                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `OKDB.defaults`                                                  | default storage options (`mapSize`, `pageSize`, `compression`, `durability`, …)       |
| `OKDB.KNOWN_OPTIONS`                                             | `Set` of every constructor option name; an unknown key logs one warning per process   |
| `OKDB.implementation`                                            | always `'native'` in okdb 3                                                           |
| `OKDB.nativeBinaryPath`                                          | the native file this process loaded ([C bridge](./c-bridge.md))                       |
| `OKDB.HIGH_SENTINEL`                                             | open-ended upper bound for index ranges ([Querying](./querying.md))                   |
| `OKDB.clone(src, dst)` / `OKDB.reidentify(path)`                 | copy a store as a new node ([Migration](./migration.md#cloning-a-store-new-identity)) |
| `OKDB.registerViewReducer()` / `OKDB.registerBucketProjection()` | process-wide view extensions ([Views](./views.md))                                    |

**Instance**

| Member                                                                                                                    | What it is                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `open()` / `close()` / `state`                                                                                            | lifecycle (`created` → `started` → `stopped`; a failed `open()` leaves it `stopped`)                                    |
| `env(name)` / `default` / `openEnv(name)`                                                                                 | an open env / the default env / open a registered env on demand                                                         |
| `createEnvironment(name, config)` / `removeEnvironment(name)`                                                             | create / delete an env ([Data Model](./data-model.md))                                                                  |
| `put`, `get`, `query`, `registerType`, … on `db`                                                                          | shortcuts to the `default` env                                                                                          |
| `queue`, `files`, `views`, `processor`                                                                                    | the default env's queue, files, views and processor                                                                     |
| `fts`, `embeddings`, `engines`, `pipelines`, `functions`, `sync`, `auth`, `http`, `mcp`, `licenses`, `migrate`, `plugins` | feature APIs (see their pages)                                                                                          |
| `processors.start()` / `stop()` / `status()`                                                                              | processing participation ([Roles & Deployment](./deployment.md))                                                        |
| `role`, `info`, `id`, `version`, `getResolvedOptions()`, `quarantinedEnvs`                                                | introspection                                                                                                           |
| `pressure()`, `diag()`                                                                                                    | load signal and diagnostics ([Diagnostics](./diagnostics.md))                                                           |
| `locks`                                                                                                                   | named cross-process mutexes: `await db.locks.tryAcquire(id)` → `{ acquired, handle, current }`, then `handle.release()` |
| `bus`                                                                                                                     | the local UDP bus that wakes peer processes on the same store (`state`, `isRunning`), or null                           |
| `bootRuntimeDeclarations()`                                                                                               | boot stored engines / pipelines / views now (what `open()` does unless `runtimeDeclarations: false`)                    |
| `meta`, `processes`                                                                                                       | type/index metadata ([Data Model](./data-model.md)) and the [process registry](./process-registry.md)                   |

```js
const OKDB = require('@kedem/okdb');

console.log(OKDB.defaults.durability); // 'balanced'
console.log(OKDB.KNOWN_OPTIONS.has('processors')); // true

const db = new OKDB('./mydb');
await db.open();
const { acquired, handle } = await db.locks.tryAcquire('nightly-report');
if (acquired) {
    // ... only one process on this store runs this at a time ...
    await handle.release();
}
await db.close();
```

### The native loader

`@kedem/okdb/native-loader` is the module the package entry uses to find the native file. It is useful for health checks and
for hosts that need the paths without opening a store:

<!-- not-runnable: needs the installed package layout (native/ next to the loader) -->

```js
const loader = require('@kedem/okdb/native-loader');

loader.platformKey(); // 'linux-x64-gnu' on a supported host, null elsewhere
loader.bundledKeys(); // platforms bundled in this package: ['linux-x64-gnu']
loader.bundledPath('linux-x64-gnu', 'addon'); // .../native/linux-x64-gnu/okdb-node.linux-x64-gnu.node
loader.bundledPath('linux-x64-gnu', 'launcher'); // .../native/linux-x64-gnu/okdb
loader.locate('addon'); // { path, key, source: 'env' | 'bundled', reason? } — never throws
const p = loader.probe(); // loads the addon once: { ok: true, path, key, bindingVersion } or { ok: false, reason }
if (!p.ok) console.error('okdb unavailable:', p.reason);
```

`describeHost()` names the host (`'linux/x64/glibc'`), `isMusl()` detects musl, and `loadedPath()` is the real path of the
loaded addon (null before `probe()`).

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
