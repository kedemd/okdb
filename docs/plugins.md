# Plugins

Plugins are first-class addons that extend OKDB before it opens. They integrate into the lifecycle cleanly: registered before `open()`, started after `open()`, stopped before `close()`.

---

## Registering a plugin

```javascript
const okdb = new OKDB('./db');

okdb.plugins.register(MyPlugin, {
    /* options */
});

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
        okdb.http.get('/api/my-plugin/ping', async (req, res) => {
            res.json({ ok: true });
        });

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
okdb.plugins.register(MyPlugin, {
    /* options passed to register() */
});
await okdb.open();
```

After registration, `okdb.my-plugin` is set to the instance object — so the plugin becomes a property on `okdb`:

```javascript
okdb['my-plugin']; // → the instance returned by register()
```

:::note
Plugin name must not conflict with existing OKDB properties (`env`, `put`, `get`, `http`, etc.). Registration throws `PLUGIN_NAME_CONFLICT` if there's a clash.
:::

---

## Lifecycle contract

| Phase                     | Hook  | IO allowed | Purpose                                       |
| ------------------------- | ----- | ---------- | --------------------------------------------- |
| `register(okdb, options)` | sync  | **no**     | Attach routes, event listeners, declare types |
| `instance.start(okdb)`    | async | **yes**    | Start servers, timers, workers                |
| `instance.stop(okdb)`     | async | **yes**    | Stop everything started in `start()`          |

If any plugin's `start()` throws, all already-started plugins are stopped in reverse order before the error propagates.

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

The `okdb.info` response also includes the plugin list:

```javascript
const info = await fetch('/api/info').then((r) => r.json());
info.plugins; // → ['schema', 'auth', 'payments']
```
