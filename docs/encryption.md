# Encryption & Key Rotation

okdb encrypts a store at rest when you give it an `encryptionKey`. With a key, nothing under the database folder holds your data in
clear: the environments, their full-text indexes, time-machine history, file blobs (their names too) and vector-search snapshots
are all encrypted. Without a key, the files are plain.

```js
const OKDB = require('@kedem/okdb');

const db = new OKDB('./secure-db', { encryptionKey: '0123456789abcdef0123456789abcdef' }); // 32 characters
await db.open();
await db.env('default').ensureType('notes');
await db.env('default').put('notes', 'n1', { text: 'only readable with the key' });
await db.close();
```

## Two layers of keys

Your key (the **user key**) never encrypts data directly. Every encrypted environment has its own random 32-byte **data key**;
everything in the environment is encrypted with keys derived from it (its LMDB files, its blob and snapshot files, the names of its
blobs). The data key is stored only wrapped (AES-256-GCM) by the user key, in a small file next to the environment's data:
`<env-path>/keyring`. An environment without encryption has no keyring.

This is what makes rotation cheap and safe:

- **changing the user key** rewraps the data keys — no data is rewritten, nothing closes;
- **re-encrypting** gives an environment a new data key and rewrites its files under it (also how encryption is added to, or
  removed from, an environment).

## Where keys come from

- `encryptionKey` — the instance key: it covers `~system` and every environment without a key of its own.
- `createEnvironment(name, { encryptionKey })` — an environment's own key. A static key is kept in the environment registry (as
  it always was) — in clear unless the instance itself has a key, since the registry lives in `~system`; a **function** key is
  never stored, so prefer one for an environment-only key.
- A key may be a **function** (sync or async) returning the key. okdb calls it at `open()` and again whenever another process
  changes the key, so a key held in a vault or a secrets manager is fetched fresh:

```js
const OKDB = require('@kedem/okdb');

const fetchKey = async () => '0123456789abcdef0123456789abcdef'; // e.g. read from your secrets manager
const db = new OKDB('./fn-key-db', { encryptionKey: fetchKey });
await db.open();
await db.createEnvironment('vault', { encryptionKey: async () => 'fedcba9876543210fedcba9876543210' });
await db.close();

// an environment created with a function key needs it again on the next open
const again = new OKDB('./fn-key-db', {
    encryptionKey: fetchKey,
    encryptionKeys: { vault: async () => 'fedcba9876543210fedcba9876543210' },
});
await again.open();
await again.openEnv('vault');
await again.close();
```

Keys live in process memory only: never in a log line, a bus datagram or shared memory.

## Changing the key

```js
const OKDB = require('@kedem/okdb');

const db = new OKDB('./rotate-db', { encryptionKey: '0123456789abcdef0123456789abcdef' });
await db.open();
await db.changeEncryptionKey({ to: 'abcdefabcdefabcdefabcdefabcdef12' }); // the instance key (and ~system)
await db.createEnvironment('vault', { encryptionKey: 'fedcba9876543210fedcba9876543210' });
await db.changeEncryptionKey({ env: 'vault', to: '00112233445566778899aabbccddeeff' }); // one environment's own key
await db.close();
```

`changeEncryptionKey({ env?, to })` rewraps the data keys of the environment (with its sub-environments that use the same key) or,
without `env`, of everything that uses the instance key. The old key no longer opens the store. Other processes keep working —
they hold their data keys in memory: a process with a function key fetches the new key; a process with a static key logs that its
next open needs the new key. `to` may be a function too. CLI: `okdb rekey --key <current> --to <new> [--env <name>]` (or
`OKDB_NEW_ENCRYPTION_KEY` instead of `--to`).

Changing the user key does not change the data keys: someone who kept the old key **and** an old copy of a keyring can still read
the data of that copy. To revoke that, re-encrypt.

## Re-encrypting an environment

```js
const OKDB = require('@kedem/okdb');

const db = new OKDB('./reencrypt-db', { encryptionKey: '0123456789abcdef0123456789abcdef' });
await db.open();
await db.createEnvironment('plain', { encryptionKey: null }); // explicitly unencrypted
await db.env('default').ensureType('t');
await db.env('default').put('t', 'k', { v: 1 });

await db.reencrypt({ env: 'default' }); // a new data key, the same user key
await db.reencrypt({ env: 'plain', to: 'fedcba9876543210fedcba9876543210' }); // add encryption
await db.reencrypt({ env: 'plain', to: null }); // remove it again
await db.close();
```

`reencrypt({ env, to? })` rewrites the environment (and its embeddings sub-environments) under a new data key — under the same
user key (`to` omitted), a new one (`to`: a key or a function), or without encryption (`to: null`). It runs in the calling process
and coordinates every other process on the store by itself:

1. it takes the environment's exclusive lease (no compaction or second re-encryption meanwhile) and records its progress in
   `<env-path>/rekey.json`;
2. every process closes the environment. **Reads and writes on it wait** — they continue when it is back (after
   `OKDB_REKEY_WAIT_MS`, 10 minutes by default, a call fails with the retryable `REKEY_IN_PROGRESS`);
3. once no process holds the environment's files, it rewrites the environment, its full-text index, time-machine history and
   blobs under the new key, and drops its vector snapshots (they rebuild);
4. it switches the keyring and signals; every process reopens the environment by itself, unwrapping the new data key with the user
   key it holds. When encryption was just added, a process needs the key (a function key, or `encryptionKeys`); one without it logs
   an error and keeps the environment closed.

A crash is safe: the next process that needs the environment sees the interrupted run and finishes it. If other processes do not
let go of the environment within `OKDB_REKEY_PEER_WAIT_MS` (60 s), nothing is changed and the call fails with the retryable
`REKEY_PEERS_BUSY`. `~system` cannot be re-encrypted in place (`REKEY_SYSTEM_UNSUPPORTED`); change its key with
`changeEncryptionKey`. CLI: `okdb rekey --reencrypt --env <name> [--to <key> | --plain]`.

## Errors

| Code                                                    | Meaning                                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY_INVALID`                                | the key given is not a key of this environment (its keyring is wrapped by another one)       |
| `ENCRYPTION_KEY_REQUIRED`                               | the environment is encrypted but no key was given (or its function key was not passed again) |
| `ENV_ENCRYPTION_MISMATCH`                               | an LMDB file of an encrypted environment is not encrypted (or the reverse)                   |
| `FILE_NOT_ENCRYPTED`                                    | a blob of an encrypted environment is not encrypted                                          |
| `REKEY_IN_PROGRESS` / `REKEY_BUSY` / `REKEY_PEERS_BUSY` | retryable: a re-encryption (or compaction) is running                                        |

## Upgrading from 3.0

A store encrypted by 3.0 keeps its key as each environment's data key: the 3.1.0 storage migration writes the keyrings and
re-encrypts the files 3.0 left plain; no encrypted data is rewritten. Rotate the data keys afterwards with `reencrypt` if you want
them random.
