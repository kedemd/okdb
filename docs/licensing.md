# Licensing

OKDB runs without a license on a **free tier** that is enough to evaluate and build something
real. A license is a signed file from your vendor that unlocks additional features and raises
limits. Licenses are managed from the CLI (below), the admin UI, or from code
([`db.licenses`](#from-code), `OKDB_LICENSE_FILE`):

```bash
okdb license [<blob|path|uuid|activation-token>] [--path <db-dir>]
```

Licenses are stored **inside the database** (in the `~system` environment), so always point the
command at the same data directory your server runs with — via `--path`, the `OKDB_PATH`
environment variable, or the `path` key in `.kdbconfig`.

---

## Free tier

With no license stored, OKDB applies the free tier:

| Feature | Free tier | Feature       | Free tier     |
| ------- | --------- | ------------- | ------------- |
| `fts`   | ✓         | `sync`        | ✗             |
| `views` | ✓         | `embeddings`  | ✓ (pipelines) |
| `files` | ✓         | `engines`     | ✗             |
| `mcp`   | ✓         | `timeMachine` | ✗             |

| Limit                          | Free tier |
| ------------------------------ | --------- |
| Environments (incl. `default`) | 5         |
| Types per env                  | 10        |
| Embeddings pipelines per env   | 2         |
| Total writes                   | 1,000,000 |

The free tier is sized so an embedded code index (e.g. okcode: a management env plus one env per
workspace, each with an embeddings pipeline) works out of the box for up to three workspaces,
semantic search included. `embeddings` covers embeddings **pipelines** — their embedder, indexer
and vector-search members (which are engines under the hood) are licensed by it. The generic
`engines` platform — custom engine drivers and standalone engines — needs a license with
`engines`. `pipelinesPerEnv` is a free-tier-only limit: licenses have no such field, so a license
that enables `embeddings` is never bounded by it.

Using a disabled feature throws `LICENSE_FEATURE_DISABLED`; crossing a limit throws
`LICENSE_LIMIT_EXCEEDED`. A license lists its own feature set and limits — anything the
vendor left unset is unlimited.

---

## Activating a license file

Your vendor sends you a `.license` file. The flow has two steps, because standard licenses are
**bound to one node**: the database generates a PIN unique to this node + license pair, and the
vendor answers with an activation token.

### 1. Add the license file

```bash
okdb license ./acme.license --path ./okdb-data
```

The CLI reads the file, verifies the signature, stores the license, and prints a **PIN**:

```
  ✓ License added
    licensee:  Acme Corp
    ...
    PIN:       AB3D-EF7H

  Next step — activate the license:
    1. Send the PIN above (AB3DEF7H) to your license vendor.
    2. You will receive an activation token.
    3. Run:  okdb license <activation-token>
```

The PIN is derived from the node identity and the license — it contains no secrets and is safe
to send over email or chat.

You can also paste the license blob string directly instead of a file path — the CLI
auto-detects what it was given.

### 2. Apply the activation token

```bash
okdb license <activation-token>
# or, if the vendor sent it as a file:
okdb license ./acme-activation.txt
```

```
  ✓ License activated
    licensee:  Acme Corp
```

Done. A running server picks the change up on its periodic license recheck; restart it if you
want the new tier immediately. (Licenses added through the admin UI or `db.licenses` take
effect immediately in that process.)

### Open licenses (POC / demo)

Some licenses are issued as **open**: not node-bound, maximum 6 months validity. These are
active immediately after step 1 — no PIN, no activation token. The server logs a warning
banner while an open license is active, as a reminder that it is for evaluation only.

---

## Managing licenses

```bash
okdb license                 # list all stored licenses, current tier, and usage
okdb license <uuid|prefix>   # details for one license (features, limits, status, usage)
okdb license remove <id>     # remove a stored license
```

The list shows each license's status:

| Status       | Meaning                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| `active`     | Verified and in effect (the first active license wins)                     |
| `pending`    | Added but not yet activated — send the PIN to your vendor                  |
| `expired`    | Past its expiry date; the node falls back to the next license or free tier |
| `wrong_node` | The activation belongs to a different node identity (see below)            |
| `invalid`    | The blob is corrupt or not signed by the key this build trusts             |

`okdb serve` also prints a one-line license summary at startup (licensee and expiry, or the
current free-tier usage).

---

## From code

An embedded application installs its license with `db.licenses` (available after `open()`;
calling it before throws `INVALID_STATE`):

```js
const db = new OKDB('./data');
await db.open();

const lic = await db.licenses.add(fs.readFileSync('./acme.license', 'utf8'));
// → { id, type: 'standard'|'open'|'internal', licensee, status, effective,
//     needsActivation, pin, addedAt, expiresAt, features, limits, changed }

if (lic.needsActivation) {
    // standard (node-bound) license: send lic.pin to the vendor, then
    await db.licenses.add(activationToken); // or db.licenses.activate(activationToken)
}

db.licenses.effective(); // { free, id, type, licensee, expiresAt, features, limits, enforced }
db.licenses.list(); // every stored license, summarized
await db.licenses.remove(id);
```

- **Input**: `add()` takes the license text — a blob, an activation token (auto-detected), a
  blob and its token separated by whitespace (a license file with the token on a second line), or
  `{ blob, activation }` to add and activate in one call. It takes the text, not a file path.
- **Immediate**: a successful `add`/`activate`/`remove` reloads the license state, so the new
  tier applies in this process right away (other processes on the same path pick it up at their
  periodic recheck, or on restart).
- **Idempotent**: re-adding a stored license (or re-applying its token) is a no-op that returns
  the existing record with `changed: false` — safe to call on every start.
- **Errors**: a malformed license, or one not signed by the key this build trusts, throws
  `LICENSE_INVALID`; a token that does not verify on this node throws
  `LICENSE_ACTIVATION_INVALID`; a wrong argument shape throws `INVALID_INPUT`.
- **Nothing sensitive leaves the store**: results are summaries (never the blob or token), and
  okdb never logs license or token content. The PIN is safe to share.
- `effective().enforced` is `false` on dev builds, where features and limits are reported but
  not checked.

### `OKDB_LICENSE_FILE`

Set `OKDB_LICENSE_FILE` to a file holding the license — a blob, an activation token, or a blob
and its token on separate lines — and `open()` installs it through the same idempotent path,
**before** any license-gated feature or engine starts (so the first boot is already licensed).
Child processes that inherit the variable install nothing new (the license is already stored).
A missing or invalid file is a warning naming the error code — never the file's content — and
`open()` continues on whatever is already stored (or the free tier).

---

## Node identity, reset, and moving a database

The activation is bound to the node identity created when the database was first initialized.
Two consequences:

- **`okdb reset` preserves your license.** The reset command deliberately carries the node
  identity and all stored licenses into the fresh database, so activation survives.
- **Deleting the data directory by hand does not.** A new directory means a new node identity;
  previously activated licenses show `wrong_node` and need a re-activation from your vendor
  (add the license again, send the new PIN).

The same applies to copying a license between machines: the blob can be added anywhere, but
each node needs its own activation.

---

## Expiry

The server rechecks licenses periodically. When the active license expires, the node logs a
warning, emits a `LICENSE_INVALID` event, and drops to the next valid license or the free tier
— by default it **keeps running** (`onLicenseExpired: 'log'`). Set the constructor option
`onLicenseExpired: 'shutdown'` (or `OKDB_LICENSE_EXPIRED_ACTION=shutdown`) to make the process
exit instead.

---

## Errors

| Code                         | When                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `LICENSE_INVALID`            | Blob corrupt, duplicate, or signed by a key this build does not trust — the error includes the build's expected key fingerprint |
| `LICENSE_ACTIVATION_INVALID` | Token malformed, or no stored license matches it — add the license blob first                                                   |
| `LICENSE_FEATURE_DISABLED`   | The current tier does not include the feature                                                                                   |
| `LICENSE_LIMIT_EXCEEDED`     | An operation would cross a licensed limit                                                                                       |
