# Plugins

Plugins are first-class addons that extend OKDB before it opens. They integrate into the lifecycle cleanly: registered before `open()`, started at the end of `open()`, stopped before `close()`.

> **3.0 notes.** The 2.x plugin contract is unchanged, with three differences: `start()` runs after the
> **whole** `open()` has finished (in 2.x it ran mid-open, before views and runtime declarations
> booted), so a plugin always sees a fully started instance but can no longer act before those boot;
> `okdb.api` and `okdb.admin` are stubs whose members throw `NOT_IMPLEMENTED_NATIVE` — drive the
> server through HTTP routes or the public facades instead; and `_`-prefixed internals of the 2.x
> JS implementation no longer exist. The standalone `okdb` CLI loads no plugins (as in 2.x):
> plugins exist where an application embeds okdb in Node.

---

## Registering a plugin

```javascript
const MyPlugin = { name: 'my-plugin', register: () => ({}) };
const okdb = new OKDB('./db');

okdb.plugins.register(MyPlugin, {/* options */});

await okdb.open();
await okdb.close();
```

Plugins must be registered **before** `okdb.open()`. Attempting to register after open throws `INVALID_STATE`.

---

## Writing a plugin

A plugin module is a plain object with a `name`, an optional `requires` list, and a `register` function that returns an instance.

```javascript
// my-plugin.js
const MyPlugin = {
    name: 'my-plugin',

    // Other plugin names that must be registered first
    requires: [],

    // Called synchronously during okdb.plugins.register().
    // Must NOT do IO. Returns the plugin instance.
    register(okdb, options) {
        // Attach routes, listen to events, etc.
        // http.add(method, path, handler) — the handler gets { params, query, body, ... }
        // and returns { result }; the response body is the { data, error, meta } envelope.
        okdb.http.add('GET', '/api/my-plugin/ping', async () => ({ result: { ok: true } }));

        // The returned object becomes the instance
        return {
            async start(okdb) {
                // Called after okdb.open() — IO is allowed here
                console.log('my-plugin started');
            },
            async stop(okdb) {
                // Called before okdb.close() — clean up everything
                console.log('my-plugin stopped');
            },
        };
    },
};
module.exports = MyPlugin;
```

<!-- continues -->

```javascript
// const MyPlugin = require('./my-plugin');
const okdb = new OKDB('./db');
okdb.plugins.register(MyPlugin, {/* options passed to register() */});
await okdb.open(); // logs 'my-plugin started'
await okdb.close(); // logs 'my-plugin stopped'
```

The instance is kept internally — it is **not** attached as a property on `okdb`. If callers need it, keep your own reference (e.g. export it from the plugin module).

:::note
Plugin name must not conflict with existing OKDB properties (`env`, `put`, `get`, `http`, etc.). Registration throws `PLUGIN_NAME_CONFLICT` if there's a clash, `PLUGIN_ALREADY_REGISTERED` for a duplicate name, and `BAD_PLUGIN` when `name` is missing or `register()` doesn't return an object.
:::

---

## Lifecycle contract

| Phase                     | Hook  | IO allowed | Purpose                                       |
| ------------------------- | ----- | ---------- | --------------------------------------------- |
| `register(okdb, options)` | sync  | **no**     | Attach routes, event listeners, declare types |
| `instance.start(okdb)`    | async | **yes**    | Start servers, timers, workers                |
| `instance.stop(okdb)`     | async | **yes**    | Stop everything started in `start()`          |

`start`/`stop` are optional. Plugins start in registration order at the end of `open()` and stop in reverse order during `close()`. If any plugin's `start()` throws, all already-started plugins are stopped in reverse order (the throwing plugin's `stop()` is not called), then `open()` releases everything else it had opened and rethrows the error; the instance is left stopped, so `close()` is a no-op.

---

## Plugin dependencies

Use `requires` to declare that another plugin must be registered first:

```javascript
const payments = {
    name: 'payments',
    requires: ['auth'], // 'auth' plugin must be registered before 'payments'
    register(okdb, options) {
        return {};
    },
};
const okdb = new OKDB('./db');
try {
    okdb.plugins.register(payments);
} catch (e) {
    console.log(e.code); // PLUGIN_DEPENDENCY_MISSING
}
```

OKDB checks this at registration time and throws `PLUGIN_DEPENDENCY_MISSING` if the dependency isn't registered yet.

---

## Example: type initializer plugin

A common pattern is a plugin that ensures types and indexes exist at startup:

```javascript
const schemaPlugin = {
    name: 'schema',
    register(okdb, options) {
        return {
            async start(okdb) {
                await okdb.ensureType('users', {
                    indexes: [['email'], ['role', 'createdAt']],
                });
                await okdb.ensureType('sessions', {
                    indexes: [['userId'], ['expiresAt']],
                });
                console.log('[schema] types ready');
            },
            async stop() {},
        };
    },
};
module.exports = schemaPlugin;

const okdb = new OKDB('./db');
okdb.plugins.register(schemaPlugin);
await okdb.open(); // types exist once open() resolves
await okdb.close();
```

---

## Listing registered plugins

`okdb.info` (and `GET /api/info`) includes the registered plugin names:

```javascript
const okdb = new OKDB('./db');
okdb.plugins.register({ name: 'schema', register: () => ({}) });
await okdb.open();
okdb.info.plugins; // → ['schema']
await okdb.close();
```

<!-- not-runnable: needs a running server (the network) -->

```javascript
const info = await fetch('http://localhost:8484/api/info').then((r) => r.json());
info.data.plugins; // → ['schema', 'auth', 'payments']
```
