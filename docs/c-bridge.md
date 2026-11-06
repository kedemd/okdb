# C bridge

The native file in `@kedem/okdb` (`native/linux-x64-gnu/okdb-node.linux-x64-gnu.node`) is one binary with two front doors:

- **Node.js** loads it as an addon (Node-API) — that is what `require('@kedem/okdb')` does;
- **any other program** (C, C++, Rust, Go, Zig, ...) can `dlopen()` it and talk to okdb through a stable C ABI, without compiling
  okdb in and without Node. An editor or agent process such as okcode uses okdb this way.

The contract is the header `okdb_bridge.h`, attached to each okdb release on GitHub next to the native file. This page is an
overview; the header is the reference.

## Loading

```c
#include <dlfcn.h>
#include "okdb_bridge.h"

void *so = dlopen("/path/to/okdb-node.linux-x64-gnu.node", RTLD_NOW | RTLD_LOCAL);
okdb_bridge_fn get = (okdb_bridge_fn)dlsym(so, "okdb_bridge");
const OkdbBridgeV1 *ok = get ? get(OKDB_BRIDGE_ABI_MAJOR) : NULL;   /* NULL: this file does not speak ABI 1 */
```

The file has no undefined Node-API symbols, so it loads into a plain process. `okdb_bridge(1)` returns the function table
`OkdbBridgeV1`: `version`, `open`, `attach`, `close`, `dispatch`, `dispatch_batch`, `submit`, `free`, `set_host`, `pump`,
`cli_main`, and, in later minors, `submit_batch` (1.1) and `read` (1.2).

## Requests

Every call carries MessagePack. A request is `[scope, env | nil, method, args]` — the same scopes and methods the JavaScript
binding uses (`["env", "default", "put", ["docs", "k1", {"body": "hi"}]]`, `["env", "default", "get", ["docs", "k1"]]`). A reply
is `{"ok": value}` or `{"err": {"code", "message", "details"?}}`, with the same error codes the JavaScript API throws; the return
status (`OKDB_OK`, `OKDB_ERR`, `OKDB_INVALID`, `OKDB_WRONG_THREAD`, `OKDB_CLOSED`, `OKDB_PANIC`, `OKDB_UNSUPPORTED`) is the coarse
class. Every buffer okdb returns is released with `free(ptr, len)`. `dispatch_batch` runs an array of requests as one write group.

## Open or attach

- **`open(path, opts, flags, &h, ...)`** opens a standalone instance (options as in `new OKDB(path, opts)`). Without flags the
  calling thread is the owner and must call **`pump(h, budget_ms, &next_ms)`** from its loop: it runs processor drains, timers,
  lease heartbeats and queued submits, and says when to call again. `OKDB_OPEN_OWNER_THREAD` makes okdb run its own owner thread
  (no pump needed; `dispatch` from other threads is forwarded). `OKDB_OPEN_DEFER` constructs without opening, so callbacks can be
  registered first; then send `["bridge", nil, "open", []]`.
- **`attach(native_handle, &h, ...)`** joins an instance a Node.js host in the same process already opened, instead of opening the
  store a second time. Call it on that instance's JavaScript thread; `close()` only detaches. From Node, the host finds the same
  image with `require('@kedem/okdb').nativeBinaryPath` (dlopen it with `RTLD_NOLOAD`), and the handle with
  `db._native.bridgeHandle()` (`db._native.bridgeTable()` is the table's address, `db._native.bridgeLibPath()` the image path).

```js
// in the Node host, before handing the instance to native code in the same process
const OKDB = require('@kedem/okdb');
const db = new OKDB('./mydb');
await db.open();

const image = OKDB.nativeBinaryPath; // dlopen(image, RTLD_NOW | RTLD_NOLOAD)
const handle = db._native.bridgeHandle(); // pass to table->attach() on this thread
console.log(image, handle);
await db.close();
```

## Threads

An okdb instance is single-threaded: everything runs on its owner thread. `dispatch` / `dispatch_batch` from another thread
fail with `OKDB_WRONG_THREAD` (except on owner-thread handles, which forward and block). Two calls work from **any** thread:

- **`submit` / `submit_batch`** queue a request; its `done(ctx, status, reply, len)` callback runs later on the owner thread.
- **`read`** (ABI 1.2) runs a read-only request on the **calling** thread, with no hop to the owner and no pump: the env read
  methods (`get`, `getEntry`, `has`, `count`, `getMany`, `getRange`, `getKeys`, `getValues`, `getCount`, `getByPrefix`,
  `getIndex`, `byIndex`, `countByIndex`) against committed data. Anything else answers `READ_METHOD_NOT_ALLOWED`. This is how a
  worker thread reads without blocking the owner.

## Host callbacks

Features that call user code — chunk strategies, embedder factories and embedders, queue and processor handlers, event
subscriptions — take functions in JavaScript. Over the bridge a function is the marker `{"$fn": <id>}` with an id the host picks;
`set_host(h, &host)` installs the host's `OkdbBridgeHostV1` vtable (`call`, `release`, `free_reply`, `drop`), and okdb calls
`host.call(ctx, op, args)` on the owner thread when it needs the function.

## The CLI

`cli_main(argc, argv)` (also exported as `okdb_cli_main`) runs the `okdb` command line inside the calling process. The `okdb`
launcher shipped in the package is a small program that does exactly that.

## ABI versions

The ABI is **major 1, minor 2**. Within a major, the function table, the host vtable and the message shapes only grow: fields are
appended, never removed or reordered. Before using a field added in a later minor, check the table's `struct_size`:

```c
#include <stddef.h>
int has_read = ok->struct_size >= offsetof(OkdbBridgeV1, read) + sizeof ok->read;   /* ABI 1.2 */
```

okdb reads `host->struct_size` the same way. A breaking change would be a new major (`OkdbBridgeV2`), and `okdb_bridge(1)` keeps
answering as long as major 1 is supported. `version()` returns the okdb package version, for features newer than the ABI minor
(new methods).
