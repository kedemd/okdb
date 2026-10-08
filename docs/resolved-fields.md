# Resolved fields — index content okdb doesn't store

Full-text search and embeddings only need a document's text **while indexing it** and **when showing a result**. They never store it: FTS keeps posting lists, embeddings keep vectors. So the text can live anywhere — files on disk, an object store, another service — and okdb only needs a way to read it.

A **resolved field** is that way: the app registers a function that turns a row into the field's content. The row itself stays small — the item's identity, its version, and whatever you want to filter by.

```javascript
const env = okdb.env('default');
await env.registerType('code');

// Rows are metadata only: identity + version (+ filter fields).
await env.put('code', 'src/loop.js', { rel: 'src/loop.js', hash: 'a91f…', lang: 'js' });

// The content comes from disk.
await env.resolveField('code', 'content', async (row) => {
    try {
        return await fs.promises.readFile(path.join(ROOT, row.rel), 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null; // gone — no content
        throw err;
    }
});

// Index it like any stored field.
await okdb.fts.ensure('code', 'text', { fields: ['rel', 'content'] }, env);
await okdb.embeddings.createPipeline('code', {
    source_type: 'code',
    field: 'content',
    chunk: { strategy: 'paragraph' },
    embedder,
});
```

Queries work exactly as with stored content — `env.ftsQuery(...)`, `pipeline.api.search(...)` — and match against the indexes, never the text. Search results that carry chunk text read it through the resolver and verify it against the chunk hash, so a changed file never shows the wrong text.

For files uploaded with `okdb.files`, you don't need to write this yourself: `files.indexContent()` declares a built-in resolver on `~files` that reads the blob and extracts its text, and installs it in every process automatically — see [Searching file contents](./files.md#searching-file-contents).

## Keeping rows in step with the content

The row is the **version**: rewrite it when the content changes (a new content hash is the natural choice), and the normal change feed re-indexes it — FTS re-tokenizes, embeddings re-embeds only the chunks whose text changed. Delete the row and both indexes drop the item. Don't rewrite a row whose content didn't change.

Keeping rows in step is the app's job — for files, a scanner: walk the folder, hash changed files, upsert or delete rows. `fs.watch` makes a good hint to scan sooner, not a source of truth.

## Resolver contract

`resolver(row, key)`:

| returns            | meaning                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| a value            | the field's content                                                                                                                   |
| `null`/`undefined` | no content (e.g. file gone) — indexed as an absent field                                                                              |
| throws             | a read error for this item only: FTS keeps its previous postings and records the error; embeddings marks the doc `failed` (retryable) |

A stored value always wins: a row that has `content` uses it, and the resolver is not called.

### Batch resolvers

When one call per row is expensive — a remote source, one round trip per file — register a batch resolver. FTS drains, FTS builds and the embeddings indexer then resolve many rows per call:

```javascript
await env.resolveField('code', 'content', null, {
    batchSize: 256, // rows per call (default 256)
    batch: async (items) => {
        // items: [{ row, key }] → values in the same order
        const files = await remote.readMany(items.map(({ row }) => row.rel));
        return items.map(({ row }) => files.get(row.rel) ?? null); // an Error value fails that item only
    },
});
```

Returning an `Error` instance for an item fails that item only; throwing fails every item in that call. With only `batch` registered, single reads (search-result chunk text) go through it with one item.

## Every process that indexes needs the resolver

The declaration is durable (it survives restarts and is visible to every process on the path); the resolver is code, so each process that runs FTS or embeddings processors must call `resolveField` after `open()`. One that doesn't fails loudly with `FIELD_RESOLVER_MISSING` rather than silently indexing empty text — and HOLDS the work instead of failing it: FTS and the embeddings indexer keep their processor cursor behind the change (the error shows in the processor's status — `error`, or `lastError` while it stays online — and in the log; the indexer's `stats().waiting` reports `{ reason: 'FIELD_RESOLVER_MISSING', field }`), queue-mode embedding jobs are re-queued without using a try, and affected docs stay `pending`, never `failed`. Registering the resolver resumes both right away — no manual retry. Registering resolvers after `open()` is therefore safe even though indexers restored at open may reach the field first. `env.unresolveField(type, field)` removes the declaration.

## Limits

- **The content is local to where the resolver can reach it.** Rows and derived indexes replicate; the content doesn't. A peer without access can't index or show snippets.
- **Stale window.** Between a content change and the row update, the indexes describe the old content. Embeddings detects it (chunk hash mismatch); for FTS snippets, compare your stored hash.
- **Secondary indexes** apply to stored fields only (`rel`, `lang`, …) — the content is searchable through FTS and embeddings, not through `registerIndex`.
