# Plugins

Plugins are first-class addons that extend OKDB before it opens. They integrate into the lifecycle cleanly: registered before `open()`, started after `open()`, stopped before `close()`.

---

## Registering a plugin

```javascript
const okdb = new OKDB('./db');

okdb.plugins.register(MyPlugin, {/* options */});

await okdb.open();
```

Plugins must be registered **before** `okdb.open()`. Attempting to register after open throws `INVALID_STATE`.

---

## Writing a plugin

A plugin module is a plain object with a `name`, an optional `requires` list, and a `register` function that returns an instance.

```javascript
// my-plugin.js
module.exports = {
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
```

```javascript
const MyPlugin = require('./my-plugin');
okdb.plugins.register(MyPlugin, {/* options passed to register() */});
await okdb.open();
```

The instance is kept internally (`okdb.plugins._plugins[i].instance`) — it is **not** attached as a property on `okdb`. If callers need it, keep your own reference (e.g. export it from the plugin module).

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

`start`/`stop` are optional. Plugins start in registration order at the end of `open()` and stop in reverse order during `close()`. If any plugin's `start()` throws, all already-started plugins are stopped in reverse order before the error propagates.

---

## Plugin dependencies

Use `requires` to declare that another plugin must be registered first:

```javascript
module.exports = {
    name: 'payments',
    requires: ['auth'],   // 'auth' plugin must be registered before 'payments'
    register(okdb, options) { ... },
};
```

OKDB checks this at registration time and throws `PLUGIN_DEPENDENCY_MISSING` if the dependency isn't registered yet.

---

## Example: type initializer plugin

A common pattern is a plugin that ensures types and indexes exist at startup:

```javascript
module.exports = {
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
```

---

## Listing registered plugins

```javascript
const names = okdb.plugins._plugins.map((p) => p.module.name);
// e.g. ['schema', 'auth', 'payments']
```

`okdb.info` (and `GET /api/info`) also includes the plugin list:

```javascript
okdb.info.plugins; // → ['schema', 'auth', 'payments']

const info = await fetch('/api/info').then((r) => r.json());
info.data.plugins; // → ['schema', 'auth', 'payments']
```
