# Files

OKDB includes content-addressable blob storage integrated with the database. File bytes are stored once per SHA-256 hash on disk; each file is a metadata record in the `~files` OKDB type.

`okdb.files` is the default environment's files API; every user environment has its own at `env.files` (see [Files per environment](#files-per-environment)).

---

## Uploading a file

`upload()` takes the bytes (a readable stream, a `Buffer`/`Uint8Array`, or a string) and an id you choose:

```javascript
const fs = require('node:fs');
const path = require('node:path');

const localFile = path.join(__dirname, 'alice.jpg');
fs.writeFileSync(localFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // stand-in image bytes

const record = await okdb.files.upload({
    id: 'avatar-alice', // required — the ~files key
    stream: fs.createReadStream(localFile), // required — a stream, Buffer or string
    mime: 'image/jpeg', // default 'application/octet-stream'
    path: '/avatars/alice.jpg', // optional, full path incl. filename
});
// record = { id, hash, size, mime, path, createdAt }

// From a Buffer
await okdb.files.upload({ id: 'notes-1', stream: Buffer.from('hello'), mime: 'text/plain', path: '/notes/1.txt' });
```

The bytes are streamed to disk while hashed, then stored in the environment's blob store, `<env-path>/~blobs/<first2>/<rest>` (the SHA-256 hex; in an encrypted environment the file is encrypted and named by an HMAC of the hash, see [Storage layout](#storage-layout)). Uploading the same bytes again in the same environment stores them once — the new record points at the existing blob and its reference count goes up. Uploading again under an existing `id` replaces the file: the record is overwritten and the previous blob's reference is released (its file is deleted once nothing else references it). Re-uploading the same bytes under the same `id` leaves the reference count unchanged.

Pass `txn` to make the metadata write part of a transaction: the record is written with the transaction, the reference counts (including the release of a replaced blob) are updated after it commits, and a newly written blob is deleted if it rolls back — a rollback leaves the previous blob untouched.

<!-- continues -->

```javascript
await okdb.registerType('invoices');
const stream = fs.createReadStream(localFile); // any readable stream

const txn = okdb.transaction();
await okdb.files.upload({ id: 'invoice-7', stream, mime: 'application/pdf', path: '/invoices/7.pdf', txn });
txn.put('invoices', '7', { file: 'invoice-7', total: 120 });
await txn.commit();
```

---

## Reading a file

<!-- continues -->

```javascript
// Metadata (sync) — the ~files record or null
const meta = okdb.files.get('avatar-alice');

// The whole blob as a Buffer
const buf = await okdb.files.read('avatar-alice');

// Stream it
const download = await okdb.files.stream('avatar-alice'); // → { stream, record }
download.stream.pipe(fs.createWriteStream(path.join(__dirname, 'copy.jpg'))); // e.g. pipe into an HTTP response
```

`read()` and `stream()` reject with `status: 404` when the id is unknown, or when the record exists but its blob is not on this node (`Blob missing for file: <id>`). `get()`, `read()` and `stream()` never create the `~files` type.

---

## Deleting a file

<!-- continues -->

```javascript
await okdb.files.remove('avatar-alice');

const tx = okdb.transaction();
await okdb.files.remove('invoice-7', { txn: tx }); // inside a transaction
await tx.commit();
```

`remove()` deletes the metadata record and decrements the blob's reference count; the blob file is deleted when no `~files` record references that hash any more. It rejects with `status: 404` when the id is unknown.

---

## Listing files

<!-- continues -->

```javascript
// Everything (up to `limit`, default 1000)
const all = await okdb.files.listPath('/');

// Under a directory prefix
const docs = await okdb.files.listPath('/docs/'); // recursive by default
const top = await okdb.files.listPath('/docs', { recursive: false, limit: 100 });
```

`listPath()` returns an array of `~files` records whose `path` is under the prefix. `~files` has secondary indexes on `path` and `hash`, so the ordinary query API works too — e.g. `okdb.query('~files', { hash })`.

---

## Events

Uploads and removals made without `txn` emit `files:uploaded` (`{ id, hash, size, path }`) and `files:removed` (`{ id, hash }`) on `okdb.events`. HTTP uploads also emit `files:http:uploaded`.

---

## HTTP API

When the HTTP server is running, file routes are mounted for the default environment at `/api/files` and for any environment at `/api/env/:env/files`:

| Method   | Path                      | Description                                                                                                                                                                                                                                                                 |
| -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/files?path=…`       | Upload. The raw request body is the file; `Content-Type` becomes `mime`; `Content-Length` is required. The id is a generated UUID. → `201 { result: record }`                                                                                                               |
| `GET`    | `/api/files`              | List. Query: `path` (prefix, default `/`), `recursive` (default `true`), `limit` (default 100, max 10000). → `{ result: [records], meta: { count } }`                                                                                                                       |
| `GET`    | `/api/files/:id`          | Download the bytes (`content-type` from the record, `content-disposition: attachment` with the path's filename)                                                                                                                                                             |
| `GET`    | `/api/files/:id?inline=1` | Preview in the browser (`content-disposition: inline`). Only passive media — non-SVG images, audio, video, PDF — keep their type; everything else (HTML, SVG, XML, JS, unknown) is served as `text/plain`, always with `nosniff` and a sandboxing `Content-Security-Policy` |
| `GET`    | `/api/files/:id/status`   | Metadata plus `blob: { refs }`                                                                                                                                                                                                                                              |
| `DELETE` | `/api/files/:id`          | Remove → `204`                                                                                                                                                                                                                                                              |

Blob routes address one environment's blob store with `?env=<name>` (default: `default`):

| Method | Path                      | Description                                                                            |
| ------ | ------------------------- | -------------------------------------------------------------------------------------- |
| `GET`  | `/api/files/blobs/status` | The local blob table: `{ hash, refs, nodes, onDisk, sizeBytes }` per blob              |
| `GET`  | `/api/files/blobs/:hash`  | The raw bytes of one blob (used by peers to replicate blobs)                           |
| `POST` | `/api/files/blobs/sync`   | Pull missing blobs from sync peers now. Body: `{ peerIds?: string[] }` (`files:write`) |

Downloads honour a single `Range: bytes=…` request (`206`, or `416` when unsatisfiable) for media seeking and partial reads. Reads need the `files:read` permission, writes `files:write`.

```bash
# Upload
curl -X POST "http://localhost:8080/api/files?path=/docs/report.pdf" \
  -H "Authorization: Bearer my-token" \
  -H "Content-Type: application/pdf" \
  --data-binary @report.pdf

# Download by id
curl http://localhost:8080/api/files/3f1c…-uuid \
  -H "Authorization: Bearer my-token" \
  --output report.pdf

# Files of another environment
curl "http://localhost:8080/api/env/analytics/files?path=/exports/" -H "Authorization: Bearer my-token"
```

---

## Files per environment

Each OKDB environment has its own `~files` type and its own blob store (`<env-path>/~blobs`). This means:

- The same bytes stored twice in one environment are one file on disk; stored in `default` and in `analytics` they are two
- Reference counting tracks how many of the environment's records point to each hash; the blob is deleted when that drops to zero
- An environment's blobs are encrypted with that environment's key (its own `encryptionKey`, else the instance's), and `removeEnvironment()` deletes them with it

```javascript
await okdb.createEnvironment('analytics');
const analytics = okdb.env('analytics');
await analytics.files.upload({ id: 'q3', stream: 'region,total\nEU,120\n', mime: 'text/csv', path: '/exports/q3.csv' });
```

---

## Storage layout

```text
<env-path>/~blobs/
  ab/cdef1234...   ← blob file (path = first2/rest of the SHA-256 hex; with a key: of HMAC-SHA256(file key, hash), contents encrypted)
  ff/0123abcd...
  tmp/             ← in-flight uploads
```

Records and the API always carry the real SHA-256. Before 3.1 all environments shared `<okdb-root>/~blobs`; the 3.1.0 storage migration moves each blob into every environment that references it.

In the database:

```text
~files              ← metadata records, per env (id → { id, hash, size, mime, path, createdAt })
~file:blob_status   ← ref-counting sub-db, per env (hash → { refs, nodes })
```

Maintenance helpers: `files.getBlobStatus(hash)` → `{ refs, … } | null`, `files.listBlobStatus()` (the blob table), `files.gcOrphanedBlobs({ minAgeMs })` (deletes blob files whose ref count is 0 or unknown and that no `~files` record references, skipping blobs modified in the last `minAgeMs` — default 10 minutes — since an upload in flight writes its blob before its record; returns the count).

---

## Sync

`~files` metadata **is replicated** across sync peers like any other type. Blob bytes are **not** — they move over HTTP between nodes:

- After a local upload, the node asks each peer to pull from it (`POST /api/files/blobs/sync`); the peer then downloads the blobs it lacks.
- `await okdb.files.syncBlobs({ peerIds? })` pulls every missing blob from the peers now (→ `{ synced, errors }`).

So metadata can arrive before the bytes. Until they do, `read()`/`stream()` on that node reject with `Blob missing` (404). Content indexing (below) tries the peers itself.

---

## Searching file contents

Full-text search and embeddings can index what is **in** the files, not only their paths. Turn it on once per environment:

```javascript
await okdb.files.upload({
    id: 'report',
    stream: 'Quarterly revenue grew 12%.',
    mime: 'text/plain',
    path: '/docs/report.txt',
});

await okdb.files.indexContent(); // or env.files.indexContent({ field, maxBytes })
```

This declares `content` on `~files` as a [resolved field](./resolved-fields.md): nothing is copied into the database — when an index needs a file's content, okdb reads the blob and runs a matching **extractor** to turn the bytes into text. Then index `~files` like any type:

<!-- continues -->

```javascript
// Full-text search over path + content
await okdb.fts.ensure('~files', 'text', { fields: ['path', 'content'] });
await okdb.fts.flush('~files');
const hits = okdb.ftsQuery('~files', 'text', 'quarterly revenue');
for (const { key, value } of hits) console.log(key, value.path); // report /docs/report.txt
```

Semantic search over the same content:

<!-- not-runnable: needs an ML model -->

```javascript
const pipeline = await okdb.embeddings.createPipeline('file-search', {
    source_type: '~files',
    field: 'content',
    dims: 1024,
    chunk: { strategy: 'paragraph' },
    embedder: { type: 'ollama', model: 'mxbai-embed-large', url: 'http://localhost:11434' },
});
const similar = await pipeline.api.search('how do refunds work?', { limit: 5 });
```

Uploads and removals re-index through the normal change feed: a new file is indexed when it lands, and `remove()` drops it from both indexes.

Options:

| option     | default     | meaning                                                           |
| ---------- | ----------- | ----------------------------------------------------------------- |
| `field`    | `'content'` | the resolved field name on `~files`                               |
| `maxBytes` | 16 MiB      | larger files get no content (they stay findable by stored fields) |

The setting is durable: every process that opens the store — a restart, a second process on the same path, a clustered worker — serves the built-in resolver on its own; you don't call `indexContent()` again. `env.unresolveField('~files', 'content')` turns it off.

### Extractors

Built in: `text/*`, `application/json`, `application/xml`, `application/javascript`, `*+json` and `*+xml` are decoded as UTF-8. Nothing else is built in — okdb ships no PDF/Office parsers. For other formats, register an extractor:

```javascript
// Your choice of parser — okdb has no dependency on it. Stand-ins for this example:
const pdfToText = async (buffer) => buffer.toString('latin1');
const docxToText = async (buffer) => null;

okdb.files.registerExtractor('application/pdf', async (buffer, record) => {
    return await pdfToText(buffer); // string, or null for "no content"
});

// A wildcard or a predicate on the record also works
okdb.files.registerExtractor('application/vnd.openxmlformats-officedocument.*', docxToText);
const unregister = okdb.files.registerExtractor(
    (record) => record.path.endsWith('.log'),
    (buf) => buf.toString('latin1'),
);
unregister(); // registerExtractor returns an unregister function
```

- `match` is a mime (`'application/pdf'`), a wildcard (`'text/*'`, `'*+json'`), or a predicate `(record) => boolean`. Mime parameters are ignored (`text/plain; charset=utf-8` matches `text/plain`).
- `fn(buffer, record)` returns the text (`string`), or `null` for no content; it may be async. Throwing fails that one file (see below).
- Later registrations win over earlier ones and over the built-ins. `registerExtractor` returns an unregister function.
- Extractors apply to every environment of that OKDB instance.

**Extractors are code, so register them in every process that runs FTS or embeddings processors** — the same rule as for [resolvers](./resolved-fields.md#every-process-that-indexes-needs-the-resolver). The built-in text extractor needs nothing; a process without your PDF extractor simply treats PDFs as having no content.

### What gets content

| file                                        | indexed as                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| a matching extractor returned text          | its content                                                                                            |
| no extractor matches its mime (e.g. images) | no `content` — still findable by stored fields (`path`, …); embeddings mark it `empty`                 |
| larger than `maxBytes`                      | no `content` (the blob is not read)                                                                    |
| the extractor returned `null`               | no `content`                                                                                           |
| the extractor threw                         | an error for that file only: FTS keeps its previous postings, embeddings marks it `failed` (retryable) |

### Blob not on this node yet

When metadata has replicated but the bytes haven't, the resolver first tries to pull the blob from the sync peers (the same blob transfer `syncBlobs()` uses). If no peer has it, or no peers are configured, it fails that file with a retryable `FILE_BLOB_MISSING` error — per the resolver contract, FTS keeps the file's previous postings and embeddings marks it `failed` (retryable), rather than indexing it as empty.
