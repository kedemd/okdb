# Auth Permissions

This page documents the permission model used by okdb tokens.

## What a permission is

A permission is a string in the form `namespace:operation` (e.g. `data:read`, `queue:work`).
Each API route declares the single permission required to call it.

Tokens carry two kinds of grants:

- **Global permissions** (`permissions` array) — apply to every request regardless of which environment it targets.
- **Per-env grants** (`grants` object) — extra permissions that apply only when a request targets a specific named environment.

The effective grant set for a given request is the union of both.

## The permission model

26 permissions across 11 user-facing namespaces and 1 gate.

### Environment-scoped namespaces

These can be granted globally or as per-env grants.

| Namespace   | Operations              | What it covers                                                                                                  |
| ----------- | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `data`      | `read`, `write`         | Records: get/list/byIndex, create/update/delete, bulk import                                                    |
| `schema`    | `read`, `write`         | Type definitions, all index registrations (byIndex, FTS, vector), TTL policy                                    |
| `search`    | `query`                 | Run FTS / vector searches                                                                                       |
| `queue`     | `read`, `write`, `work` | `read`=list/stats; `write`=enqueue/cancel/retry/clear/buckets; `work`=worker-side claim/heartbeat/complete/fail |
| `files`     | `read`, `write`         | Blob storage: upload, download, list, delete, metadata                                                          |
| `functions` | `read`, `write`, `run`  | `read`=list/inspect; `write`=register/update/delete; `run`=execute                                              |
| `views`     | `read`, `write`         | `read`=list/query views, meta, definition; `write`=create/delete/start/stop/rebuild                             |
| `env`       | `read`, `write`         | Env lifecycle: list, info, create, delete, compact                                                              |

### System-scoped namespaces

These are global only (per-env grants cannot hold them).

| Namespace | Operations              | What it covers                                                          |
| --------- | ----------------------- | ----------------------------------------------------------------------- |
| `auth`    | `read`, `write`         | API tokens and users                                                    |
| `system`  | `read`, `write`         | Server info, logs, events, processor status, backups, engines, licence  |
| `sync`    | `read`, `write`, `peer` | Cluster replication — `peer` is for machine-to-machine only (see below) |

The `/api/env/:env/engines…` routes are `system:*` (so a grant must be global — see above) but
still declare `scope: 'env'`: a token needs `system:write` to manage engines anywhere, and
additionally `protected:write` to manage them in a `~`-prefixed env such as `~system` (see
[The `protected` gate](#the-protected-gate)). `ttl` routes follow the same pattern.

### Gate

| Namespace   | Operations      | What it covers                                                                                                     |
| ----------- | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `protected` | `read`, `write` | Required to act on a system env (names starting with `~`, e.g. `~system`), combined with the underlying permission |

## Implied permissions

Three rules. Everything else is explicit.

```
data:read    → schema:read  (can't read records without seeing their schema)
data:write   → schema:read  (can't write records without knowing their type)
search:query → schema:read  (searches return records; caller needs the type definition)
```

Implication is one-directional. `schema:read` does not imply `data:read`.

## Wildcards

| Grant                  | Matches                                |
| ---------------------- | -------------------------------------- |
| `*`                    | Everything                             |
| `ns:*` (e.g. `data:*`) | All operations in the namespace        |
| `*:op` (e.g. `*:read`) | The given operation in every namespace |

## Per-env grants

Shape of a token with per-env grants:

```json
{
    "permissions": ["auth:read"],
    "grants": {
        "production": ["data:read", "schema:read"],
        "staging": ["data:*"]
    }
}
```

The token can list tokens globally, read records in `production`, and do anything data-related in `staging`.

:::note
Per-env grants are only consulted on routes that resolve their env from the path (the route
declares `access.scope: 'env'` or `{ env: 'params.env' }`). That covers every env-scoped
feature — records, types/indexes/TTL/FTS/vector, views, subscriptions, env admin, files, queue,
functions, pipelines and time machine — so e.g. a per-env `files:read` or `queue:work` grant
works exactly like a per-env `data:read` grant. `tests/auth-routes-have-permissions.test.js`
fails the build for any `:env` route whose permission is missing that declaration, so this list
stays accurate.
:::

## The `protected` gate

System environments (names prefixed `~`, such as `~system`) store internal okdb state. To act on
one — e.g. `GET /api/env/~system/type/~envs/item/default` — the caller needs **both**:

1. The underlying namespace permission (`data:read` to read, `data:write` to write, `queue:work` to claim, etc.)
2. The matching `protected:read` or `protected:write` gate.

Write-side operations (`write`, `work`, `run`, `peer`) require `protected:write`. Read-side operations (`read`, `query`) require `protected:read`. The gate may be held globally or as a grant on that env.

The gate is keyed on the **env**, not the type: `~`-prefixed types inside a user env (e.g.
`~files` in `default`) need only the ordinary `data:*` permission. Like per-env grants, the gate
is only applied on routes that resolve their env from the path (see the note above).

## `sync:peer` — machine permission

`sync:peer` gates the cluster replication endpoints. A node holding this token can receive replicated data for any namespace. **Do not grant it to human users.**

## Time machine, licence, and setup permissions

- **Time machine** (`/api/env/:env/time-machine…`) is env-scoped (`scope: 'env'`), so per-env
  grants and the protected `~` env gate both apply:
    - Status/config reads (`GET …/time-machine`, `…/types`, `…/types/:type`, the deprecated
      `…/status`) need `schema:read` — the same permission as index/FTS status.
    - Document history, point-in-time state, and diffs (`…/:type/:key/history`, `…/:type/:key/at/:clock`,
      `…/changes`) are document contents, so they need `data:read`.
    - Enabling/disabling/dropping/flushing tracking (`…/types/:type/enable|disable|drop|flush`,
      `…/enable-all`, `…/disable-all`, incl. the deprecated per-env `…/enable`/`…/disable`) needs
      `schema:write` — the same permission as registering or dropping an index.
- **Licence** (`/admin/license…`) is a `system:*` namespace, so it is global only:
  `GET /admin/license/status` needs `system:read`; `POST /admin/license`,
  `POST /admin/license/:id/activate` and `DELETE /admin/license/:id` need `system:write`.
- **Setup join** (`POST /admin/setup/join`) needs `sync:write` — joining starts replicating this
  node's data to the remote, so it is cluster configuration like `PUT /api/sync/links`. First-run
  setup in open/bootstrap mode bypasses the permission check (there is no token yet).

## Cookbook: common token recipes

### Read-only browser client

```json
{ "permissions": ["data:read"] }
```

`schema:read` is implied — no need to add it.

### App backend (full CRUD + search + queue admin)

```json
{ "permissions": ["data:read", "data:write", "search:query", "queue:read", "queue:write"] }
```

### Queue worker

```json
{ "permissions": ["queue:work", "data:write"] }
```

`queue:work` to claim and complete jobs; `data:write` (or whatever the job needs) to do the work.

### Per-env scoped read-only token

```json
{
    "permissions": [],
    "grants": { "production": ["data:read"] }
}
```

### Cluster peer node

```json
{ "permissions": ["sync:read", "sync:peer"] }
```

`join()` first reads `GET /api/sync/info` (`sync:read`); `sync:peer` alone does not imply it.

## Adding a new permission

1. Add the namespace/operation to `src/features/auth/okdb-auth-namespaces.js` in `NAMESPACES`.
2. Add `permission: 'ns:op'` to the route's `access` object.
3. The catalog endpoint at `GET /admin/api/auth/permissions` picks it up automatically — no UI changes needed.
