# Auth and Sync

This document covers how authentication works, how tokens are issued and verified, how OAuth fits in, and how node-to-node sync is secured — including the current gap in sync auth and what to do about it.

For the full list of permissions, operations, and token recipes see **[Auth Permissions](./auth-permissions.md)**.

---

## Part 1 — Authentication

### The core invariant

Every authenticated request goes through a single path:

```
HTTP request
    ↓
db.auth.authenticateRequest(req)
    ↓
token verification
    ↓
auth result { type, roles, isAuthenticated }
```

There is no user database. Authentication is entirely config-driven.

---

### Auth modes

```
auth.mode = "open" | "secure"
```

| Mode     | Behaviour                                                                                |
| -------- | ---------------------------------------------------------------------------------------- |
| `open`   | All requests pass. A system user with `admin` role is injected. No credentials required. |
| `secure` | All `/api/*` and `/admin/*` routes require a valid token or credential.                  |

**Legacy alias:** `mode: "users"` is treated as `"secure"` for backward compatibility.

**Default behaviour** — mode is inferred automatically if not set:

| Config present                                | Inferred mode |
| --------------------------------------------- | ------------- |
| `auth.admin` or `auth.tokens` or `api.tokens` | `secure`      |
| Nothing                                       | `open`        |

---

### Configuration

A complete `.kdbconfig`:

```json
{
    "port": 8484,
    "path": "./okdb-data",
    "auth": {
        "mode": "secure",
        "admin": "admin:password",
        "tokens": {
            "my-api-key": ["admin"],
            "read-only-key": ["read"]
        }
    }
}
```

Or in code:

```js
const okdb = new OKDB('./data', {
    auth: {
        mode: 'secure',
        admin: 'admin:password',
        tokens: {
            'my-api-key': ['admin'],
            'read-only-key': ['read'],
        },
    },
});
```

CLI flags override config:

```bash
okdb --auth open              # force open mode
okdb --admin admin:secret     # set admin credential
```

---

### Credential types

There are exactly three credential types in the system:

#### 1. Admin credential (`auth.admin`)

```json
{ "auth": { "admin": "admin:password" } }
```

- A single `username:password` string in config.
- Used **only** by the admin UI login form (`POST /auth/login`).
- On success, the server issues an **HMAC session token**, sets it in a cookie, and returns it in the response body.
- Node-local. Not replicated. Not stored in the database.

#### 2. Static tokens (`auth.tokens`)

```json
{ "auth": { "tokens": { "my-key": ["admin"], "ro-key": ["read"] } } }
```

- Named tokens with explicit role lists, defined in config.
- Sent as `Authorization: Bearer <token>` on every request.
- Verified by a **direct map lookup** — no HMAC, no expiry.
- Node-local. Not replicated.
- Also accepted as a plain array (backward compat): `["my-key"]` → all get `["admin"]` role.

Legacy `api.tokens` is automatically merged into static tokens:

```json
{ "api": { "tokens": ["my-token"] } }
```

#### 3. Issued HMAC tokens

These are short-lived tokens created by the server after a successful login or OAuth exchange.

**Structure** (not a JWT):

```
base64url(payload).hmac_sha256(payload, tokenSecret)
```

Payload:

```json
{
    "iat": 1710400000000,
    "exp": 1710403600000,
    "sub": "admin",
    "username": "admin",
    "roles": ["admin"]
}
```

- Default TTL: **1 hour**
- Clock-skew tolerance: **30 seconds**
- `tokenSecret` is auto-generated per node and stored in the local LMDB as `__tokenSecret` (never replicated)
- Sent as `Authorization: Bearer <token>` or via the `okdb_session` cookie

---

### Token verification order

For every incoming request with a `Bearer` token:

```
1. Check static token map  → immediate if found
2. Verify HMAC issued token → if signature valid and not expired
3. Validate OIDC access token → if oauth.issuer is configured
4. Reject → 401
```

Cookie path (admin UI sessions):

```
1. Verify HMAC issued token from cookie
2. Reject → 401
```

---

### Login flow (admin UI)

```
POST /auth/login
{ "username": "admin", "password": "password" }
```

Server:

1. Compares against `auth.admin` credential (case-insensitive username)
2. If match → issues HMAC token
3. Returns token in body + sets `okdb_session` cookie
4. Returns `{ access_token, expires_in }`

The issued token can then be used as a Bearer token for API calls.

---

### OAuth flow

OAuth is used **only to obtain a token**. It does not create users, does not store identities, and does not require a user database.

```
GET /admin/auth/start?redirect=/admin/index.html
    → redirect to OAuth provider

GET /admin/auth/callback?code=...&state=...
    → exchange code with provider
    → receive email + subject from provider
    → check email against allowedEmails / allowedDomains
    → if allowed: issue HMAC token, set okdb_session cookie, redirect
    → if not allowed: 403
```

The token payload for OAuth logins uses the email as `username` and roles from `defaultRoles` config (defaults to `["admin"]`).

**Nothing is persisted.** The OKDB node itself is not an identity provider. OAuth is just a way to authenticate to obtain a node-local session token.

#### Email allowlisting (required)

You **must** configure `allowedEmails` or `allowedDomains` (or both) to specify which accounts are accepted. If neither is set, **all OAuth logins are rejected** (secure by default).

| Field            | Type       | Description                                                  |
| ---------------- | ---------- | ------------------------------------------------------------ |
| `allowedEmails`  | `string[]` | Exact email addresses, e.g. `["alice@corp.com"]`             |
| `allowedDomains` | `string[]` | Domain suffixes, e.g. `["corp.com"]` matches `*@corp.com`    |
| `defaultRoles`   | `string[]` | Roles assigned to allowed OAuth users (default: `["admin"]`) |

If an email matches **either** list, it is allowed.

Configure OAuth via the `auth.providers` block:

```js
const okdb = new OKDB('./data', {
    auth: {
        mode: 'secure',
        providers: {
            google: {
                issuer: 'https://accounts.google.com',
                clientId: 'YOUR_CLIENT_ID',
                clientSecret: 'YOUR_CLIENT_SECRET',
                redirectUri: 'http://localhost:8484/admin/auth/callback',
                scopes: ['openid', 'email', 'profile'],

                // Who is allowed to authenticate (required — no allowlist = all rejected)
                allowedDomains: ['mycompany.com'], // anyone @mycompany.com
                allowedEmails: ['contractor@gmail.com'], // specific external accounts
                defaultRoles: ['admin'], // roles for allowed users

                getAuthorizationUrl: ({ state }) => `https://accounts.google.com/o/oauth2/v2/auth?...&state=${state}`,
                exchangeCode: async ({ code }) => {
                    // exchange code for tokens, return { subject, email, claims }
                },
            },
        },
    },
});
```

The same allowlist applies to direct OIDC bearer tokens (API/MCP clients sending a Google access token as `Authorization: Bearer <jwt>`).

---

### Route protection summary

| Route               | Requirement                                              |
| ------------------- | -------------------------------------------------------- |
| `GET /api/*`        | Any valid token (static, issued, or OIDC), or open mode  |
| `POST /auth/login`  | No auth (public endpoint)                                |
| `POST /auth/logout` | No auth (public endpoint)                                |
| `GET /admin/login`  | No auth (public endpoint)                                |
| `GET /admin/*`      | Valid token in cookie or Bearer header with `admin` role |
| `/api/sync/*`       | Valid token (same as API) — see note in Part 2           |

---

### `GET /admin/session`

Returns the current session state:

```json
{
    "authenticated": true,
    "user": {
        "id": "admin",
        "username": "admin",
        "roles": ["admin"]
    }
}
```

Returns `401` when not authenticated.

---

### Logout

```
POST /auth/logout
```

Clears the `okdb_session` cookie (`Max-Age=0`). No server-side state to invalidate — tokens are stateless.

---

## Part 2 — Sync

### How sync works

OKDB uses a **pull-based, last-write-wins (LWW)** replication model over HTTP. There is no central coordinator, no consensus protocol.

```
1. A write increments the local HLC clock and logs a change entry
2. On clock advance, a UDP multicast poke is sent on the LAN
3. Peers that receive the poke pull a delta from the changed node
4. Each change is compared by HLC timestamp — the higher wins
5. Ties are broken by origin node ID (lexicographic)
6. Applied changes use origin= to prevent echo-loops
```

Sync is **eventual consistency** designed for loosely-coupled topologies: multi-instance servers, edge clusters, desktop nodes.

---

### Node identity

Each node has a persistent `nodeId` (UUID) stored as `__identity` in the local LMDB. This is auto-generated on first open and never changes.

Nodes register themselves and discover peers via the `~sync_nodes` type in the `~system` environment, which itself replicates — so adding a peer on one node eventually propagates to all peers, forming a mesh.

---

### Setting up sync

```js
const okdb = new OKDB('./node1', {
    auth: {
        mode: 'secure',
        tokens: { 'cluster-secret': ['admin'] },
    },
    sync: {
        token: 'cluster-secret', // token this node sends when calling peers
        address: 'http://192.168.1.10:8484', // this node's public URL
    },
});
await okdb.open();
okdb.http.listen(8484);
```

Or in `.kdbconfig`:

```json
{
    "auth": {
        "mode": "secure",
        "tokens": {
            "cluster-secret": ["admin"]
        }
    },
    "sync": {
        "token": "cluster-secret",
        "address": "http://192.168.1.10:8484"
    }
}
```

---

### How sync auth works (current model)

#### Outbound requests (this node → peer)

When this node calls a peer to fetch a delta or register a join, it sends:

```
Authorization: Bearer <sync.token>
```

The value comes from `sync.token` in config. This is a **static Bearer token** sent on every outbound sync HTTP call.

#### Inbound requests (peer → this node)

The peer's `sync.token` must match one of the **static tokens** configured on the receiving node (`auth.tokens`).

This means the setup is:

```
node A has: auth.tokens: { "cluster-secret": ["admin"] }
node B has: sync.token: "cluster-secret"
```

Node B calls node A's `/api/sync/delta` → sends `Authorization: Bearer cluster-secret` → node A looks up `cluster-secret` in its static token map → grants access.

#### The shared-secret model

In practice, all nodes in a cluster share the **same token**:

- Every node puts the shared token in `sync.token` (so it sends it outbound)
- Every node puts the shared token in `auth.tokens` (so it accepts it inbound)

```json
{
    "auth": {
        "tokens": { "cluster-secret": ["admin"] }
    },
    "sync": {
        "token": "cluster-secret"
    }
}
```

This means a single secret grants admin access to all nodes. It's simple and works, but has the following tradeoff: **anyone who knows the sync token can make admin API calls to any node in the cluster.**

---

### Connecting nodes

#### Via code

```js
// Node 2 joins Node 1
await node2.sync.join('http://192.168.1.10:8484');
```

This:

1. Fetches `GET /api/sync/info` from Node 1 to get its node ID
2. Stores Node 1's record in `~sync_nodes` (replicates to mesh)
3. Creates a bidirectional data link
4. POSTs to Node 1's `/api/sync/join` so Node 1 registers Node 2
5. Pulls an initial delta immediately

#### Via admin UI

Go to **System → Sync → Connect**. Enter the target node's URL and click Connect.

The UI calls `POST /api/sync/connect`:

```json
{ "address": "http://192.168.1.10:8484" }
```

The joining node's `sync.token` is sent as the `Authorization` header. The target node must have that token in its `auth.tokens`.

#### Via API

```
POST /api/sync/connect
Authorization: Bearer <admin-token>
{ "address": "http://192.168.1.10:8484" }
```

---

### Multi-node cluster example

```js
const nodes = [8484, 8485, 8486].map((port) => {
    const okdb = new OKDB(`./node-${port}`, {
        auth: {
            mode: 'secure',
            tokens: { 'cluster-secret': ['admin'] },
        },
        sync: {
            token: 'cluster-secret',
            address: `http://localhost:${port}`,
        },
    });
    okdb._port = port;
    return okdb;
});

await Promise.all(nodes.map((n) => n.open()));
for (const node of nodes) node.http.listen(node._port);

// Connect node 1 and 2 to node 0 (mesh forms automatically from ~sync_nodes sync)
await nodes[1].sync.join('http://localhost:8484');
await nodes[2].sync.join('http://localhost:8484');
```

---

### What syncs and what doesn't

| Data                             | Syncs | Notes                                 |
| -------------------------------- | ----- | ------------------------------------- |
| Application data (default env)   | ✅    | All `put`/`delete` operations         |
| Custom `sync: true` environments | ✅    | Created via `createEnvironment`       |
| `~system` environment            | ✅    | Including `~sync_nodes` peer registry |
| `__identity` (node UUID)         | ❌    | Raw LMDB key, never in changelog      |
| `__tokenSecret`                  | ❌    | Raw LMDB key, never in changelog      |
| `auth.admin` credential          | ❌    | Config only, never in database        |
| `auth.tokens`                    | ❌    | Config only, never in database        |
| `sync.token`                     | ❌    | Config only, never in database        |

---

### The sync auth gap

**Current state:** Sync uses a shared static token. This works but has one weakness — the sync token is also a full admin credential on every node it's registered on. There is no per-node identity or revocation.

**Planned (Phase 2):** Cryptographic node identity using Ed25519 keypairs.

- Each node generates a keypair on first open
- Private key: stored as `__nodePrivateKey` in local LMDB, never replicated
- Public key: stored in `~sync_nodes` (replicates to peers)
- Outbound sync requests: signed with private key (`X-OKDB-NodeId`, `X-OKDB-Signature`)
- Inbound sync requests: verified against stored public key
- Trust: local-only (`__sync:trusted_peers`), non-transitive
- Discovering a peer's identity (via `~sync_nodes` replication) does **not** grant trust

Until Phase 2 is implemented, the shared-secret model is the operational approach.

---

### Sync endpoints reference

| Method  | Path                | Auth required | Description                      |
| ------- | ------------------- | ------------- | -------------------------------- |
| `GET`   | `/api/sync/info`    | Yes           | Node ID, clock, available envs   |
| `POST`  | `/api/sync/delta`   | Yes           | Pull changes since `from_clocks` |
| `POST`  | `/api/sync/join`    | Yes           | Accept incoming peer join        |
| `POST`  | `/api/sync/connect` | Yes           | Initiate join to remote node     |
| `GET`   | `/api/sync/peers`   | Yes           | List known peers and status      |
| `PATCH` | `/api/sync/self`    | Yes           | Update this node's address/meta  |

All sync endpoints require a valid token with `admin` role (same as the rest of the API).

---

### Sync config reference

```json
{
    "sync": {
        "token": "shared-secret",
        "address": "http://this-node:8484",
        "delta_limit": 500,
        "auto_reconcile": true
    }
}
```

| Key              | Default | Description                                   |
| ---------------- | ------- | --------------------------------------------- |
| `token`          | —       | Bearer token sent on outbound sync calls      |
| `address`        | —       | This node's public URL, advertised to peers   |
| `delta_limit`    | `500`   | Max changes per delta pull                    |
| `auto_reconcile` | `true`  | Automatically pull from peers on clock change |

---

## Summary

| Concept             | Mechanism                                                            |
| ------------------- | -------------------------------------------------------------------- |
| Admin UI login      | `auth.admin` credential → HMAC token → cookie                        |
| API access          | Static token (`auth.tokens`) or issued HMAC token                    |
| OAuth               | Exchange code with provider → issue HMAC token → no persistence      |
| Sync auth (current) | `sync.token` = shared static Bearer token                            |
| Sync auth (Phase 2) | Ed25519 per-node keypairs, local trust records                       |
| Token secret        | Auto-generated, stored locally as `__tokenSecret`, never replicated  |
| Node identity       | Auto-generated UUID stored locally as `__identity`, never replicated |
