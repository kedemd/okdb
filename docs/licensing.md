# Licensing

OKDB runs without a license on a **free tier** that is enough to evaluate and build something
real. A license is a signed file from your vendor that unlocks additional features and raises
limits. Everything is managed from the CLI:

```bash
okdb license [<blob|path|uuid|activation-token>] [--path <db-dir>]
```

Licenses are stored **inside the database** (in the `~system` environment), so always point the
command at the same data directory your server runs with — via `--path`, the `OKDB_PATH`
environment variable, or the `path` key in `.kdbconfig`.

---

## Free tier

With no license stored, OKDB applies the free tier:

| Feature | Free tier | Feature       | Free tier |
| ------- | --------- | ------------- | --------- |
| `fts`   | ✓         | `sync`        | ✗         |
| `views` | ✓         | `embeddings`  | ✗         |
| `files` | ✓         | `engines`     | ✗         |
| `mcp`   | ✓         | `timeMachine` | ✗         |

| Limit         | Free tier |
| ------------- | --------- |
| Environments  | 2         |
| Types per env | 10        |
| Total writes  | 1,000,000 |

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
want the new tier immediately.

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
