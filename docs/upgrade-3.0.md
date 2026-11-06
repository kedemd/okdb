# Upgrading to 3.0

okdb 3 replaces the Node.js implementation of okdb 2.x with a native core written in Rust. The JavaScript API is the same:
`new OKDB(path, options)`, environments, types, indexes, queries, views, FTS, embeddings, queue, files, functions, sync, auth, the
HTTP API and MCP behave as in 2.x. This page lists the deliberate, user-visible differences a 2.x application has to account for.

## Upgrading a store

**Stop every okdb 2.x process that uses the store, then open it with okdb 3.** Do not run 2.x and 3.x writers on the same store at
the same time: the LMDB binding 2.x uses can silently drop one concurrent commit from another process whenever it opens an
environment (a 2.x known issue; okdb 3's storage layer does not have it).

Stores open as-is: the on-disk format is unchanged, and a healthy 2.x store opens without any index rebuild (an index a crash
left mid-build is rebuilt once, as in 2.x). Backups, exports and `.kdbconfig` files carry over unchanged.

Opening an environment retries transient storage errors (for example `EINVAL`, `EAGAIN`, a map resize, a full reader table) for
about 2.4 seconds and never quarantines an environment because of them. If such an error outlasts the retries, `open()` fails and
the process should be restarted by its supervisor; there is no per-environment degraded mode for transient errors. Corruption
still quarantines the affected tenant environment immediately, and permanent failures (disk full, permissions, bad configuration)
quarantine it as in 2.x (`db.quarantinedEnvs`).

## The package

- **Native only, no JavaScript fallback.** The core ships inside the package:
  `node_modules/@kedem/okdb/native/linux-x64-gnu/okdb-node.linux-x64-gnu.node`. There is no separate platform package and no
  optional dependency to lose (`--omit=optional` and cross-platform lockfiles no longer matter). The 2.x JavaScript implementation
  is not shipped (no `okdb.js`, no `bin/okdb.js`, no worker entry files). The 2.x `OKDB_NATIVE` switch is ignored.
- **Linux x64 (glibc 2.28+) only in 3.0.** The package declares `"os": ["linux"], "cpu": ["x64"]`, so npm refuses to install it on
  macOS, Windows or arm64 (`EBADPLATFORM`). On a host npm lets through anyway (musl/Alpine, `--force`, a package manager that
  ignores `os`/`cpu`), `require('@kedem/okdb')` throws an error with `code: 'NATIVE_UNAVAILABLE'` naming the platform; `err.cause`
  is the load error when the native file exists but fails to load (for example a glibc older than 2.28). Those platforms stay on
  okdb 2.x for now; more platforms come later.
- **`OKDB_NATIVE_BINARY=<file.node>`** loads an explicit native file and wins over the bundled one (a missing file is an error,
  not a fallback). `OKDB.nativeBinaryPath` is the file actually loaded; `OKDB.implementation` is always `'native'`.
- **Fewer dependencies.** `lmdb`, `usearch`, `hnswlib-node`, `roaring`, `shmbuf`, `croner` and `uuid` are no longer dependencies
  (the core has its own LMDB binding, vector index, cron parser and shared-memory coordination). The remaining runtime
  dependencies are `msgpackr` and `sift`. Code that imported those packages through okdb's dependency tree must depend on them
  itself.
- **The `okdb` command** is a small native launcher bundled next to the core that runs the CLI inside the same native file (no
  Node needed to run it): `node_modules/@kedem/okdb/native/linux-x64-gnu/okdb`. `npx okdb` still works through a Node wrapper,
  `okdb --okdb-which` prints the launcher path, and containers can run the launcher directly. Commands, flags, `.kdbconfig` and
  the HTTP cluster (`--workers`, `--no-cluster`) are unchanged.
- **A C interface.** The same native file exports a stable C ABI for programs that are not Node.js: see [C bridge](./c-bridge.md).

```js
const OKDB = require('@kedem/okdb');

console.log(OKDB.implementation); // 'native'
console.log(OKDB.nativeBinaryPath); // .../native/linux-x64-gnu/okdb-node.linux-x64-gnu.node
```

## Errors: invalid arguments have codes

okdb 2.x let a malformed argument run into whatever it hit first and surfaced that component's error as-is: LMDB key errors
(`A key is required for get, but is undefined`, `Unable to serialize object as a key: {...}`), raw `TypeError`s
(`Cannot read properties of null (reading 'type')`, `operations is not iterable`), Node's `ERR_INVALID_ARG_TYPE`, or a type name
coerced to `"[object Object]"` and reported as `TYPE_NOT_REGISTERED`.

okdb 3 validates arguments at the API boundary and throws an `OKDBError` with a stable `code`, a message that names the argument,
and `details = { argument, expected?, got }` (`problem` instead of `expected`/`got` for `INVALID_OPTIONS`). `got` is the kind of the
value: `undefined`, `null`, `boolean`, `number`, `bigint`, `string`, `empty string`, `array`, `empty array`, `object`, `Date`,
`Map`, `Buffer`, `function`.

| code                | thrown when                                                                                                                                                                                                                                                                         | example message                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `INVALID_KEY`       | a document key or range bound that cannot be a key: `undefined`, `[]`, a plain object, a `Map`, a `Date`, a function (`get`, `getEntry`, `getMany`, `getRange`, `getKeys`, `getValues`, `getCount` bounds, `byIndex` parts, name arguments used as keys such as `db.env(name)`)     | `key must be a string, number, or array of them; got object` |
| `INVALID_TYPE_NAME` | a document type argument that is not a string (`get`, `put`, `query`, `getTTL`, `dropType`, `registerType`, HTTP `/transaction` operations, ...). `''` is a string and still answers `TYPE_NOT_REGISTERED`                                                                          | `type must be a non-empty string; got undefined`             |
| `INVALID_ARGUMENT`  | a positional argument of the wrong kind: an object, array, boolean, Date or function where a name or id is expected (`views.get({})`, `queue.pauseJobType({})`, `files.get({})`); a non-string path (`backup`); a non-function handler (`registerHandler`); a missing upload stream | `path must be a string (a filesystem path); got undefined`   |
| `INVALID_OPTIONS`   | an options object that is `null` where an object is required (`listTTL(null)`, `queue.list(null)`, `files.upload(null)`, ...), or an unknown enum value / wrong-typed option field (`fts.process({ mode })`, processor `originMode`)                                                | `options: must be an object; got null`                       |

Over HTTP all four codes are **400** with the code in the standard error envelope
(`{ "error": { "code": "INVALID_KEY", "message": "…", "details": {…} } }`; 2.x answered most of these with a code-less 500). Over
MCP they are JSON-RPC `-32602` (Invalid params) with `error.data.code` set (2.x: `-32603`).

**Absence is not an error.** A lookup of a well-formed value that names nothing still answers `undefined` / `null` / `false` /
empty, exactly as in 2.x: `get(type, null)` → `undefined`, `hasType(123)` → `false`, `views.get(undefined)` finds nothing, an
unknown (string) type → `TYPE_NOT_REGISTERED`. Only genuinely invalid input throws.

Existing codes are unchanged where they already fit (`INVALID_PRIMARY_KEY`, `INVALID_INDEX_KEY`, `INVALID_VALUE`, `BAD_PARAM`,
`INVALID_FTS`, `VIEW_INVALID_NAME`, ...).

```js
await db.registerType('users');

try {
    db.get('users', { id: 1 }); // an object is not a key
} catch (err) {
    console.log(err.code); // 'INVALID_KEY'
    console.log(err.details); // { argument: 'key', expected: '…', got: 'object' }
}

console.log(db.get('users', null)); // undefined — absence, not an error
```

**Migrating:**

- Code that matched messages such as `/A key is required/`, `/Unable to serialize object as a key/`, `/Cannot read properties/` or
  `/is not a function/` to detect bad input should branch on `err.code` instead. `err instanceof OKDBError` is now true for these
  errors (they were plain `Error` / `TypeError` before); `err.name` is `'OKDBError'`.
- HTTP clients that treated a 500 from a malformed request as a server fault now get a 400 with a code.
- Inside `env.transaction()` / `txn.commit()`, a bad type or key is reported with its own code rather than wrapped as `TXN_ERROR`.

Errors raised by user-supplied code keep the JavaScript error that code raised (function sandbox code, view `map` specs).

## Behaviour fixed in 3.0

These were 2.7.0 known issues (or found while building 3.0); code that worked around them may need a look:

- `queue.samplePayloads(type)` returns the type's payloads, latest first (limit 1–100, default 50); 2.x always returned `[]`.
- A view whose `$ref` section crashed mid-scan is rebuilt on the next open instead of staying `partially-ready`; a halted view
  restarted after a reopen is rebuilt when its state can't be trusted.
- A write with `origin: ""` counts as local everywhere: unique, schema and foreign-key checks apply.
- `VIEW_TYPE_NOT_REGISTERED` over HTTP is a 404 (was 500).
- Opening a store no longer drops a concurrent commit from another process, and a peer closing a store no longer leaves the
  others failing every write with `EINVAL`.

## Other behaviour differences

- HTTP middleware (`okdb.http.use`): code after `await next()` runs before the route handler, not after it.
- `functions.run()` held the calling event loop while the function ran in 3.0.0; from 3.0.1 it is asynchronous again (the
  loop keeps running), and a stored function's `runtime.memoryMb` is enforced per run (`FUNCTION_OOM`).
- The queue's cron expressions are parsed by okdb's own parser; the 2.x `cron_next` hook still overrides it (ignored in 3.0.0, honoured again from 3.0.1).

## Plugins

The plugin contract (`db.plugins.register(module, options)` before `open()`, `requires`, `start` / `stop` hooks, the
`PLUGIN_*` errors) works unchanged, with these differences:

- `start()` runs after the whole `open()` has finished (in 2.x it ran in the middle of open, before views and runtime
  declarations booted). A plugin sees a fully started instance.
- `okdb.api` and `okdb.admin` are stubs: any member call throws `NOT_IMPLEMENTED_NATIVE`. Use HTTP routes
  (`okdb.http.add / use / guard`) and the public facades instead.
- Plugins that reached into JavaScript internals (`_`-prefixed fields, lmdb handles such as `env.db`) have no equivalent; use the
  public API.
- The standalone `okdb` server loads no plugins (as in 2.x).

See [Plugins](./plugins.md).

## Everything else

Removed 2.x options keep throwing the same codes as 2.x (`ENVS_REMOVED`, `SYNC_OPTION_REMOVED`, `BUS_OPTION_REMOVED`,
`WORKERS_REMOVED`, `QUEUE_WORKER_REMOVED`, `HTTP_CLUSTER_REMOVED`, `DEFER_PROCESSING_REMOVED`, ...): see
[Upgrading to 2.0](./upgrade-2.0.md). The read-range rules of [2.1](./upgrade-2.1.md) and every other 2.x API are kept unless a
page in these docs says otherwise.
