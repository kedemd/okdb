# Files

OKDB includes content-addressable blob storage integrated with the database. Files are stored as SHA-256-hashed blobs on disk and tracked as metadata records in the `~files` OKDB type.

---

## Storing a file

```javascript
// From a Buffer
const file = await okdb.files.put(buffer, {
    path: '/uploads/docs/report.pdf',
    mime: 'application/pdf',
});
// file = { id, hash, size, mime, path, createdAt }

// From a stream
const stream = fs.createReadStream('/local/file.jpg');
const file = await okdb.files.put(stream, {
    path: '/avatars/alice.jpg',
    mime: 'image/jpeg',
    id: 'avatar-alice', // optional explicit ID (UUID generated if omitted)
});
```

The blob is written to `<okdb-root>/blobs/<first2>/<rest>` using the SHA-256 hex as the filename. Storing the same bytes twice stores them once — the second `put` returns a record pointing to the existing blob.

---

## Reading a file

```javascript
// Get metadata by ID
const meta = okdb.files.get('avatar-alice');
// { id, hash, size, mime, path, createdAt }

// Get the raw Buffer
const buf = await okdb.files.read('avatar-alice');

// Stream the blob
const stream = okdb.files.stream('avatar-alice');
stream.pipe(response);
```

---

## Deleting a file

```javascript
await okdb.files.remove('avatar-alice');
```

Deletion removes the metadata record. The blob bytes are garbage-collected when no other `~files` record references the same hash.

---

## Listing files

```javascript
// All files
for (const meta of okdb.files.list()) {
    console.log(meta.path, meta.size, meta.hash);
}

// By path prefix
for (const meta of okdb.files.list({ prefix: '/uploads/' })) { ... }
```

---

## HTTP upload and download

When the HTTP server is running, files are accessible via REST:

```bash
# Upload (multipart or raw body)
curl -X POST http://localhost:8080/api/files \
  -H "Authorization: Bearer my-token" \
  -F "file=@report.pdf" \
  -F "path=/docs/report.pdf"

# Download by ID
curl http://localhost:8080/api/files/avatar-alice \
  -H "Authorization: Bearer my-token" \
  --output avatar.jpg
```

---

## Files per environment

Each OKDB environment has its own `~files` type (metadata lives in that env), but all environments share the same blob directory at the OKDB root level. This means:

- A blob stored in the `default` env and the same blob in `analytics` share the same bytes on disk
- Reference counting tracks how many metadata records point to each hash
- The blob is only deleted when the ref count drops to zero

```javascript
// Files in a custom environment
const analyticsEnv = okdb.env('analytics');
const file = await analyticsEnv.files.put(buffer, { path: '/exports/data.csv', mime: 'text/csv' });
```

---

## Storage layout

```
<okdb-root>/blobs/
  ab/cdef1234...   ← blob file (path = first2/rest of SHA-256 hex)
  ff/0123abcd...
```

In LMDB (default env):

```
~files          ← metadata records (id → { hash, size, mime, path, createdAt })
~file:blob_status  ← ref-counting sub-db (hash → { refs, nodes })
```

---

## Sync

`~files` metadata **is synced** across cluster nodes. Blob bytes are **not** — they are transferred separately via a blob mesh protocol (HTTP) when a node needs a blob it doesn't have locally.

This means: metadata replicates instantly; actual bytes follow on demand.

:::note
Blob sync is pull-based. A node will fetch the blob from a peer only when a consumer requests it and the local blob is missing.
:::
