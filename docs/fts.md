# Full-Text Search

OKDB includes a built-in full-text search engine. All FTS data for an environment lives in two shared LMDB environments — one inverted/uncompressed (posting lists + dictionaries), one compressed (forward index). Indexes are differentiated by an auto-increment `ftsId` used as a key prefix inside the shared envs, so adding indexes adds no new files and no per-index LMDB overhead.

---

## Registering an FTS index

```javascript
await okdb.fts.register('articles', 'content', {
    fields: ['title', 'body'], // fields to index
    tokenizer: {
        minTokenLength: 2,
        maxTokenLength: 64,
        keepNumbers: true,
        toLower: true, // case-insensitive search
    },
});
```

The index builds from existing data immediately after registration. Wait for it:

```javascript
await okdb.fts.ready('articles');
```

### Multiple FTS indexes on one type

You can have several FTS indexes on the same type, each covering different fields or using different tokenizer settings. All of them share the env-level storage — adding a second index does not double your disk usage.

```javascript
await okdb.fts.register('products', 'name', { fields: ['name'] });
await okdb.fts.register('products', 'description', {
    fields: ['description'],
    tokenizer: { minTokenLength: 3 },
});
```

---

## Querying

```javascript
const results = okdb.ftsQuery('articles', 'content', 'embedded database Node.js');
for (const { key, value } of results) {
    console.log(key, value.title);
}
```

`ftsQuery` returns records that contain all of the query tokens by default (AND), as `{ key, value, version, score, numTerms, maxScore }` ordered by relevance, **at most 50 by default** (`options.limit`). Use `options.mode: 'or'` for OR semantics, and `options.prefix: true` for prefix matching. `okdb.fts.search(type, name, text, options?)` is the keys-only form (a `string[]`, same default limit).

### Relevance scoring (BM25)

Results are ranked with [Okapi BM25](https://en.wikipedia.org/wiki/Okapi_BM25) (k1 = 1.2, b = 0.75):

```
score(doc) = Σ over query tokens  idf · tf·(k1+1) / (tf + k1·(1 − b + b·docLength/avgDocLength))
idf        = ln(1 + (N − df + 0.5) / (df + 0.5))
```

- **Term frequency** — a doc that mentions a word four times outranks one that mentions it once.
- **Rarity** — a rare query word counts for more than a common one (in OR mode, a doc matching only
  the rare word beats one matching only the common word).
- **Length normalization** — a match in a short doc outranks the same match buried in a long one.
- **Prefix mode** — each query token scores its best-matching completion per doc; an exact word
  scores twice a prefix-only completion, and idf is the prefix's as a whole.

Every matching doc is scored — the top `limit` are chosen across **all** matches (a bounded top-k
heap), not the first `limit` found. Ties break by indexing order (oldest first). `score` is the BM25
value; `maxScore` is the query's upper bound (`Σ idf·(k1+1)`), so `score / maxScore` is in (0, 1).

Term frequencies are bucketed (exact up to 8, then coarser — BM25 saturates) and doc lengths are
quantized (exact up to 16 tokens, then ~12% steps); both are ranking inputs only, so the loss is
negligible.

### Combining FTS with field filters

Pass a sift-compatible filter as the fourth argument to narrow results. The filter is applied
**while ranking**: matches stream best-first and are checked against the filter until `limit` rows
pass (or the matches run out), so a selective filter still fills the page — no need to inflate
`limit`:

```javascript
const results = okdb.ftsQuery('articles', 'content', 'database performance', {
    status: 'published',
});
```

The cost is proportional to how many ranked matches must be read before `limit` pass — a filter
that rejects nearly every match reads nearly every match. `query(type, filter, { fts })` applies its
filter and index constraint the same way (see [Hybrid queries](./querying.md#hybrid-queries)).

### Options

```javascript
const results = okdb.ftsQuery('articles', 'content', 'hello world', null, {
    limit: 20,
    mode: 'and', // 'and' (default) | 'or' — OR ranks docs matching more/rarer tokens first
    prefix: false, // enable prefix matching on tokens
});
```

---

## Index management

```javascript
// Check if an index exists
okdb.fts.has('articles', 'content'); // → boolean

// Get status
okdb.fts.status('articles', 'content'); // → 'creating' | 'resetting' | 'ready' | 'error' | … | null (null = no such index)

// List all FTS indexes on a type — includes runtime state
okdb.fts.list('articles');
// → [{
//     name, status, config, created, updated, error,
//     processorState,  // per-type async processor state
//     lag,             // writes not yet indexed (0 = caught up)
//     sizeBytes,       // approximate bytes for this index (excludes shared dicts)
//   }]

// Env-level storage summary across all FTS indexes
okdb.fts.envSize();
// → {
//     diskBytes,            // ~fts/<env>/ + ~fts/<env>_docs/ data.mdb file sizes
//     payloadBytes,         // actual stored bytes (indexes + shared dicts)
//     indexPayloadBytes,    // payload attributable to indexes only
//     sharedDictBytes,      // shared docKey↔docId and token↔tokenId mappings
//     slackBytes,           // LMDB free pages (reclaimable via env.compact)
//     indexes: [{ type, name, sizeBytes }],
//   }

// Reclaim FTS slack — usually called via env.compact() which does both data and FTS
await okdb.fts.compactStorage();

// Drop an index
await okdb.fts.drop('articles', 'content');
```

---

## Storage architecture

OKDB's FTS uses a two-tier inverted index with Roaring bitmaps and ID interning. The names below are the actual LMDB sub-DB names in `~fts/<envName>/data.mdb`:

```
~fts/<envName>/data.mdb                                (uncompressed env)
  post       dupSort   [ftsId, token] → docId         (live "add" tier)
  postDel    dupSort   [ftsId, token] → docId         (live "delete" tombstones)
  frozen               [ftsId, token] → Roaring blob  (compacted tier)
  dict                 [type, 'k', docKey] → docId    (docKey ↔ docId mapping)
                       [type, 'i', docId] → docKey
                       [type, 'n'] → counter
  tokenDict            ['k', token] → tokenId         (token ↔ tokenId mapping)
                       ['i', tokenId] → token
                       ['n'] → counter

~fts/<envName>_docs/data.mdb                           (LZ4-compressed env)
  docs                 [ftsId, docId] → tokenId[]     (forward index)
```

**BM25 statistics are marker terms.** Besides its unique words, each doc is indexed under
`<word>#<tf>` for every word it contains two or more times (tf bucketed) and one `#L<length>` term
(its token count, bucketed). They live in the same posting tiers and forward index as real words,
so the live tier, compaction, rebuilds and drops maintain them with no extra machinery; `#` can
never appear in a tokenized word, and search skips markers. At query time `df` is a posting-list
size, `tf` comes from the `word#n` lists (default 1), and the `#L*` lists give each candidate's
length plus the corpus size `N` and average length.

**Why these pieces:**

| Sub-DB             | Purpose                                                                                                                          | Notes                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `post` / `postDel` | Live tier — every write goes here first. dupSort makes inserts O(1).                                                             | Compactor periodically merges these into `frozen`.                      |
| `frozen`           | Compacted tier — one Roaring bitmap per (ftsId, token) holds all matching docIds.                                                | 10–50× smaller than the equivalent dupSort entries for dense postings.  |
| `dict`             | Per-type docKey ↔ docId interning. uint32 docIds replace string keys in posting lists.                                           | One mapping per type, shared across all that type's indexes.            |
| `tokenDict`        | Env-wide token ↔ tokenId interning. uint32 tokenIds replace token strings in `docs`.                                             | "the" is the same word in every collection — one map for the whole env. |
| `docs`             | Forward index — used by the indexer to diff old vs new tokens on every write. LZ4-compressed because token arrays compress well. | Read on every doc update, not on search.                                |

**Reads** merge all three tiers: `frozen ∪ liveAdds − liveDeletes`. Roaring's set operations make this essentially free.

**Writes** only touch the live tier — never the frozen tier. The hot path is one dupSort `putSync` per added token.

### Compaction

The compactor periodically rolls live entries into the frozen tier. It runs in two situations:

1. **Automatically after `fts.flush(type)`** — keeps the live tier small after a known burst of writes.
2. **Explicitly via `fts.compactStorage(env)` or `env.compact()`** — also reclaims `data.mdb` slack by rewriting the file (LMDB never shrinks files in place; freed pages are reused but the high-water mark stays).

After a stress run of 13k docs across 5 indexes, `env.compact()` typically reclaims ~75% of the FTS file size in a few seconds, with no impact on search.

### Storage format versioning

Each registered index carries a `format` integer in its metadata. The schema has evolved (legacy → docId interning → two-tier Roaring → token interning → BM25 markers, format 5); on every open, OKDB checks each index's format and auto-rebuilds any whose format is older than the current code. This is transparent — no manual migration needed. The rebuild reads from the type's primary data, which is the source of truth.

The format 4 → 5 upgrade (BM25) is **in place**: the existing postings are kept and a re-scan adds
only the marker terms, so search keeps answering throughout — ranked by idf alone (no tf / length
data yet) until the upgrade finishes. The index reports `status: 'resetting'` meanwhile and
`fts.ready(type)` resolves when it is done; an upgrade interrupted by a restart resumes on the next
open, still without clearing. Only participating (`processors: true`) instances run it.

---

## Async indexing

FTS writes are **always async** — the FTS index is updated by a background processor after each write commits. Secondary indexes (field indexes, geo indexes) update synchronously inside the same LMDB transaction as the write, so they are immediately consistent. FTS isn't.

```javascript
await okdb.put('articles', 'a1', { title: 'Hello world' });
// At this point a1 is in the primary data but NOT YET in the FTS index.

await okdb.fts.flush('articles');
// Now it is — and the live tier has been compacted into the frozen tier.

const results = okdb.fts.search('articles', 'main', 'hello'); // includes a1
```

### `ready(type)`

`fts.ready(type)` resolves when all FTS indexes registered on `type` have completed their initial build. The optional second argument is accepted for backward compatibility but ignored — readiness is per-type, not per-index. If a build or rebuild fails, the index's status becomes `'error'` (with the message in `fts.list(type)[i].error`) and `ready(type)` rejects with `FTS_BUILD_FAILED` instead of waiting forever; `fts.reset(type, name)` (or the next `open()`) retries the build.

### `flush(type)`

`fts.flush(type)` awaits the background processor catching up to the current write position, then runs the compactor. Returns immediately if there's nothing to do.

### Processor state in `list()`

`processorState` and `lag` are per-type fields reflecting the single background processor that drives all of a type's indexes. Both have the same value on every entry of the same type.

- `processorState`: `'building' | 'online' | 'error' | 'waiting' | null` — `null` if no writes have happened yet.
- `lag`: count of writes the processor hasn't indexed yet. `0` means caught up.

---

## Tokenizer

Default behaviour:

- Splits on whitespace and punctuation
- Lowercases (when `toLower: true`, default)
- Discards tokens shorter than `minTokenLength` (default 2) or longer than `maxTokenLength` (default 64)
- Keeps numbers by default (`keepNumbers: true`)

You can override per-index in the `register()` config.

---

## Sync behaviour

FTS environments are not replicated. On a new node they rebuild from synced type data automatically — the source of truth is the primary data plus the change log, both of which are sync'd.

---

## Example: articles with FTS

```javascript
await okdb.ensureType('articles');
await okdb.fts.register('articles', 'search', {
    fields: ['title', 'body', 'tags'],
});
await okdb.fts.ready('articles');

await okdb.put('articles', 'a1', {
    title: 'Getting started with LMDB',
    body: 'LMDB is a B+ tree key-value store with MVCC...',
    tags: ['database', 'lmdb', 'storage'],
});

await okdb.fts.flush('articles');
const results = okdb.fts.search('articles', 'search', 'LMDB key value');
// → includes 'a1'
```

:::tip
FTS is good for keyword search across free-form text. For semantic similarity ("find documents about the same topic"), use [Embeddings](./embeddings.md) instead.
:::
