# Auth and Sync

How HTTP requests are authenticated, how OAuth fits in, and how sync peers authenticate to each
other.

For creating tokens and the bootstrap window see
**[Getting Started → Authentication](./getting-started.md#authentication)**. For permissions,
grants and token recipes see **[Auth Permissions](./auth-permissions.md)**.

---

## Part 1 — Authentication

### The model

Credentials are **tokens** stored in the database — the `~tokens` type in `~system`, hashed. There
are no passwords, API keys or token maps in the constructor options or `.kdbconfig`. A token has
an optional `name` + `password` (for login), a raw bearer value, `permissions` and per-env
`grants`. Create them with `okdb token create`, the admin UI, or `POST /api/auth/tokens`.

Every request goes through `db.auth.authenticateRequest(req)`:

```
1. Bootstrap window   ~tokens empty and not open mode → localhost gets full access, others refused
2. Open mode          client IP matches auth.open     → full access, no credentials
3. Bearer token       Authorization: Bearer <token>   → see "Bearer verification" below
4. Session cookie     okdb_session cookie             → login session or OAuth session
5. Otherwise          anonymous                        → 401 on protected routes
```

A sync peer's Ed25519-signed request is authenticated before this, by the sync guard (Part 2).

### Options

```js
const okdb = new OKDB('./data', {
    auth: {
        open: false, // true = localhost; or IP / CIDR / '*' string or array. CLI: --open [ip ...]
        token: { secret: undefined, ttl: 3_600_000 }, // session-token HMAC secret + TTL (ms)
        session: { secure: false, sameSite: 'Lax' }, // session cookie flags
        providers: {}, // OAuth — see below
    },
});
```

`bin/okdb` passes the `auth` block of `.kdbconfig` through unchanged; `--open` overrides
`auth.open`. `auth.token.secret` is only used the first time: the secret is persisted in the store
as `__tokenSecret` (local, never replicated) and reused from then on, generated if unset.

### Bearer verification

For `Authorization: Bearer <token>`, in order:

1. **Stored token** — the SHA-256 of the value matches a `~tokens` record → that record's
   `permissions` and `grants`.
2. **HMAC session token** — `base64url(payload).hmac_sha256(payload, tokenSecret)`, issued by
   OAuth login; payload `{ iat, exp, sub, username, roles }`, 30 s clock-skew tolerance.
3. **Login session value** — the `access_token` returned by `POST /auth/login` (below).
4. **OIDC access token** — when an OAuth `issuer` is configured: a JWT verified against the
   issuer's JWKS (RS256/ES256, `iss`, optional `audience`, `exp`/`nbf`), then the email allowlist.

Anything else is rejected; an invalid bearer never falls back to the cookie.

### Login

```
POST /auth/login
{ "username": "admin", "password": "s3cret" }
```

`username` is a token's `name` (case-insensitive), `password` its password. On success the server
sets the `okdb_session` cookie and returns `{ access_token, expires_in }`; `access_token` is also
usable as a Bearer token. The session value is sealed with the token's hash, so revoking the
token ends its sessions. Lifetime is `auth.token.ttl` (default 1 hour).

- If several tokens share the name and password, the response is
  `{ ambiguous: true, tokens: [...] }`; finish with `POST /auth/login/select` adding `tokenId`.
- `POST /auth/token` is an OAuth2 password-grant alias for MCP clients (same body, returns
  `{ access_token, token_type: "Bearer", expires_in }`, no cookie).
- `POST /auth/logout` clears the cookie. `GET /admin/session` returns
  `{ authenticated, user, grants }` or `401`.

### OAuth

OAuth only obtains a session: it creates no users and stores nothing. Configure one provider
under `auth.providers` (only the first entry is used):

```js
auth: {
    providers: {
        google: {
            issuer: 'https://accounts.google.com', // enables OIDC bearer validation
            clientId: 'YOUR_CLIENT_ID',
            redirectUri: 'http://localhost:8484/admin/auth/callback',
            scopes: ['openid', 'email', 'profile'],

            allowedDomains: ['mycompany.com'],       // required: allowedDomains and/or allowedEmails
            allowedEmails: ['contractor@gmail.com'],
            defaultRoles: ['admin'],                 // default ['admin']

            getAuthorizationUrl: ({ state, codeChallenge, redirectUri, scopes }) => '...',
            exchangeCode: async ({ code, state, redirectUri }) => {
                // return { subject, email, claims }
            },
        },
    },
}
```

```
GET /admin/auth/start?redirect=/admin/index.html  → redirect to the provider (PKCE)
GET /admin/auth/callback?code=...&state=...        → exchangeCode → email allowlist check
    allowed → HMAC session token in okdb_session, redirect
    not     → 403
```

- **Allowlist is mandatory.** With neither `allowedEmails` nor `allowedDomains`, every OAuth login
  and OIDC bearer is rejected. An email matching either list is allowed.
- The session's roles are those returned by `exchangeCode` (`user.roles`), else `defaultRoles`.
- The same allowlist applies to OIDC access tokens sent as `Authorization: Bearer <jwt>`
  (optionally checked against `audience`; `allowedAlgs`, `discoveryTtlMs`, `jwksTtlMs` tune it).

### Route protection

| Route                                                         | Requirement                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/api/*`                                                      | Authenticated, with the route's permission                                            |
| `/admin/*`                                                    | Authenticated session cookie or Bearer                                                |
| `POST /auth/login`, `/auth/token`, `/auth/logout`             | Public                                                                                |
| `/admin/auth/start`, `/admin/auth/callback`, `/admin/session` | Public                                                                                |
| `/api/sync/*`                                                 | Signed peer request, or the route's `sync:read` / `sync:peer` / `sync:write` (Part 2) |

---

## Part 2 — Sync

### How sync works

Pull-based, last-write-wins replication over HTTP; no coordinator, no consensus.

```
1. A write advances the env's HLC clock and logs a change entry
2. Peers are poked; each pulls a delta (POST /api/sync/delta) from the changed node
3. Changes are compared by HLC — the higher wins; ties broken by origin node id
4. Applied changes carry their origin, so they are not echoed back
```

Each node has a persistent `nodeId` (`__identity`) and an Ed25519 keypair (`__nodePrivateKey` /
`__nodePublicKey`), generated on first open and never replicated. Peers are recorded in the
`~sync_nodes` type in `~system` — with their address and **public key** — which itself replicates,
so the mesh forms from one join.

### How peers authenticate

**Ongoing sync is signed, not token-based.** Every outbound peer request carries
`X-OKDB-NodeId`, `X-OKDB-Timestamp`, `X-OKDB-BodyHash` and `X-OKDB-Signature`. The receiver looks
up the sender's public key in its `~sync_nodes`, checks the signature, a ±5 min timestamp window
and a replay cache, and treats the request as the peer node. No shared secret lives in config.

**Joining needs a credential once.** A node not yet in the remote's `~sync_nodes` has to pass the
remote's normal API auth for the handshake. `join()` takes either:

- `{ token }` → sent as `Authorization: Bearer <token>`; a raw token that exists in the remote's
  `~tokens`, or
- `{ username, password }` → exchanged via the remote's `POST /auth/login` for a session token,
  then sent as Bearer.

With neither, no header is sent — which only works if the remote is in open mode for this node's
IP. The joiner then POSTs its node record (with public key) to `/api/sync/join`; from there on
both sides use signatures. Because `~tokens` lives in `~system`, the remote's tokens replicate to
the joiner — cluster credentials work on every node.

The join credential needs `sync:read` (for `/api/sync/info`) and `sync:peer` (for
`/api/sync/join`) on the remote — nothing more (see
[Auth Permissions](./auth-permissions.md#syncpeer--machine-permission)).

### Connecting nodes

On node A, create a machine token for joiners:

```bash
okdb token create --label 'cluster join' --permissions 'sync:read,sync:peer'   # prints the raw token once
```

Then join from node B — CLI (direct store access; B's own reachable address is required):

```bash
okdb join http://node-a:8484 --token <raw-token> --address http://node-b:8484
# or: --username <name> --password <pass>
```

In code:

```js
const okdb = new OKDB('./node-b', { sync: { address: 'http://node-b:8484' } });
await okdb.open();
okdb.http.listen(8484);
await okdb.sync.join('http://node-a:8484', { token: process.env.OKDB_JOIN_TOKEN });
```

Over HTTP (the admin UI's **System → Sync → Connect** does this), on node B with a credential
for B that has `sync:peer`:

```
POST /api/sync/connect
{ "address": "http://node-a:8484", "token": "<raw-token-on-A>" }
```

`username` / `password` may replace `token`; `data_link: false` skips the bidirectional data
link. If B has no `sync.address`, it is taken from `my_address` in the body or the request's
`Host` header.

`join()` fetches `/api/sync/info` from A, stores A in `~sync_nodes`, creates a data link, POSTs to
A's `/api/sync/join` (where A enforces its `sync` license and peer limit — the joiner needs no
license of its own), and pulls an initial delta.

### Sync options

Constructor `sync` block (the CLI server does not read a `sync` block from `.kdbconfig`; after
`okdb join`, the node restores its address from its own `~sync_nodes` record on restart):

| Key              | Default | Description                                                                                                                                               |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `address`        | —       | This node's reachable URL, advertised to peers. Required for `join()`                                                                                     |
| `delta_limit`    | `500`   | Max changes per delta pull                                                                                                                                |
| `auto_reconcile` | `true`  | Pull from peers on clock change                                                                                                                           |
| `token`          | —       | Optional Bearer also sent on peer requests — a fallback while a peer has not yet received this node's public key. Must be a token in the peer's `~tokens` |

### What syncs

| Data                                              | Syncs | Notes                                                     |
| ------------------------------------------------- | ----- | --------------------------------------------------------- |
| Every open env with a changelog, incl. `~system`  | ✅    | `~sync_nodes`, `~tokens` travel here; data envs per link  |
| `__identity`, `__nodePrivateKey`, `__tokenSecret` | ❌    | Raw keys in `~system`, not in the log                     |
| `~migrations` (in `~system`)                      | ❌    | Node-local as of 2.4.0 — never sent or applied in a delta |

### What a peer can do

A signed request from a registered peer is treated as that node (`auth.type: 'sync-node'`):

- **Data envs** — only what the sync link allows: `/api/sync/delta` serves a peer the data envs its
  link lets this node _send_ it and omits the rest (listed in `denied`), and a pulling node applies
  only envs the link lets it _receive_ from that peer. See [Sync → Data links](./sync.md#data-links-scope-and-direction).
- **`~system`** — always, with every registered peer. It is the cluster's control plane and
  carries `~sync_nodes`, `~sync_links`, `~envs`, `~licenses`, engine/pipeline declarations and
  `~tokens`. Token records hold the SHA-256 of the raw token and a scrypt hash of the login
  password — never the raw token or password — plus `permissions`/`grants`. Node-local secrets
  (`__nodePrivateKey`, `__tokenSecret`, `__identity`) and `~migrations` are never sent.
- **Every `/api/sync/*` route** — a verified peer bypasses route permissions there.

A link therefore scopes which **data** a peer receives; it is not an isolation boundary against a
hostile peer. Any registered peer is a trusted control-plane member: the `~system` rows it
writes (links, tokens, env registry) replicate to and are applied by every node. Only join nodes
you would trust with admin rights on the cluster; a peer whose credentials must stay out of reach
belongs in a separate cluster, not behind a narrow link.

`sync:peer` **token** callers (the join handshake, a machine token) are not a link peer: they keep
the documented `sync:peer` scope — every env.

### Sync endpoints

| Method           | Path                                                             | Permission   |
| ---------------- | ---------------------------------------------------------------- | ------------ |
| `GET`            | `/api/sync/info`                                                 | `sync:read`  |
| `POST`           | `/api/sync/join`                                                 | `sync:peer`  |
| `POST`           | `/api/sync/connect`                                              | `sync:peer`  |
| `POST`           | `/api/sync/delta`                                                | `sync:peer`  |
| `POST`           | `/api/sync/reconcile`, `reconcile-all`, `reconcile-peer`, `poke` | `sync:peer`  |
| `GET`            | `/api/sync/peers`, `links`, `topology`, `gc/status`              | `sync:read`  |
| `PATCH`          | `/api/sync/self`                                                 | `sync:write` |
| `PUT` / `DELETE` | `/api/sync/links/:nodeA/:nodeB`                                  | `sync:write` |
| `POST`           | `/api/sync/gc/run`, `gc/peer/:id/resync`                         | `sync:write` |

A verified signed peer request passes all of them.

---

## Summary

| Concept        | Mechanism                                                                    |
| -------------- | ---------------------------------------------------------------------------- |
| Credentials    | Tokens in `~tokens` (`okdb token create`, admin UI, `POST /api/auth/tokens`) |
| First access   | Bootstrap window: localhost only while `~tokens` is empty                    |
| API access     | `Authorization: Bearer <token>`, or a login / OAuth session                  |
| Admin UI login | Token name + password → `POST /auth/login` → `okdb_session` cookie           |
| OAuth          | Provider code exchange → allowlist → HMAC session token; nothing stored      |
| Open mode      | `auth.open` / `--open [ip ...]` — trusted IPs skip auth                      |
| Sync join      | One-time Bearer token or name + password on the remote                       |
| Ongoing sync   | Ed25519-signed requests, public keys in replicated `~sync_nodes`             |
