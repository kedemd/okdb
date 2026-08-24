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

24 permissions across 10 user-facing namespaces and 1 gate.

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
| `env`       | `read`, `write`         | Env lifecycle: list, info, create, delete, compact                                                              |

### System-scoped namespaces

These are global only (per-env grants cannot hold them).

| Namespace | Operations              | What it covers                                                          |
| --------- | ----------------------- | ----------------------------------------------------------------------- |
| `auth`    | `read`, `write`         | API tokens and users                                                    |
| `system`  | `read`, `write`         | Server info, logs, events, processor status, backups, engines           |
| `sync`    | `read`, `write`, `peer` | Cluster replication — `peer` is for machine-to-machine only (see below) |

### Gate

| Namespace   | Operations      | What it covers                                                                                                 |
| ----------- | --------------- | -------------------------------------------------------------------------------------------------------------- |
| `protected` | `read`, `write` | Required to access system types (names starting with `~`), combined with the underlying data/schema permission |

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

## The `protected` gate

System types (names prefixed `~`) store internal okdb state. To access them the caller needs **both**:

1. The underlying namespace permission (`data:read` to read, `data:write` to write, `queue:work` to claim, etc.)
2. The matching `protected:read` or `protected:write` gate.

Write-side operations (`write`, `work`, `run`, `peer`) require `protected:write`. Read-side operations (`read`, `query`) require `protected:read`.

## `sync:peer` — machine permission

`sync:peer` gates the cluster replication endpoints. A node holding this token can receive replicated data for any namespace. **Do not grant it to human users.**

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
{ "permissions": ["sync:peer"] }
```

## Adding a new permission

1. Add the namespace/operation to `src/features/auth/okdb-auth-namespaces.js` in `NAMESPACES`.
2. Add `permission: 'ns:op'` to the route's `access` object.
3. The catalog endpoint at `GET /admin/api/auth/permissions` picks it up automatically — no UI changes needed.
