# Queue

OKDB has a built-in durable job queue.

Queue data lives in the **current environment**:

- `okdb.queue` uses the **default** environment
- `okdb.env('myenv').queue` uses that **custom** environment

Jobs survive restart, are stored as normal OKDB records, and can be listed, edited, retried, and processed by workers.

No Redis, no RabbitMQ. Just OKDB.

---

## Quick start

```javascript
const OKDB = require('okdb');

async function main() {
    const okdb = new OKDB('./db');
    await okdb.open();

    // process() runs the consumer IN THIS process — this is the model.
    // okdb does not auto-run queue handlers; keeping a consumer process alive is the
    // launcher's job. Scale by running more processes (pm2, systemd, docker).
    const worker = okdb.queue.process(
        'send-email',
        async (payload, ctx) => {
            await ctx.markProgress('sending email');

            await sendEmail(payload.to, payload.subject, payload.orderId);

            await ctx.okdb.put('email_log', payload.orderId, {
                to: payload.to,
                sentAt: Date.now(),
                jobId: ctx.jobId,
            });
        },
        {
            concurrency: 4,
            ttl: 30_000,
        },
    );

    const jobId = await okdb.queue.enqueue(
        'send-email',
        {
            to: 'alice@example.com',
            subject: 'Your order shipped',
            orderId: 'o42',
        },
        {
            max_tries: 3,
            retry_delay: 1000,
            backoff_multiplier: 2,
        },
    );

    console.log('enqueued', jobId);

    // later
    await worker.stop();
    await okdb.close();
}
```

---

## Environments

Queue data is **not** stored in a special dedicated `queue/` environment.

Instead:

- `okdb.queue.enqueue(...)` stores queue records in `default`
- `customEnv.queue.enqueue(...)` stores queue records in `customEnv`

Example:

```javascript
const okdb = new OKDB('./db');
await okdb.open();

const jobsEnv = await okdb.createEnvironment('jobs');

await okdb.queue.enqueue('default-task', { a: 1 });
await jobsEnv.queue.enqueue('custom-task', { b: 2 });
```

This is useful when you want separate queues per environment.

---

## Enqueuing jobs

```javascript
const id = await okdb.queue.enqueue('process-image', {
    fileId: 'f1',
    userId: 'u1',
});

console.log(id); // UUID string
```

### Signature

```javascript
await okdb.queue.enqueue(type, payload, options);
```

- `type` — non-empty job type string
- `payload` — any serialisable value; stored separately from job metadata
- `options` — scheduling / retry / routing metadata

### Enqueue options

```javascript
await okdb.queue.enqueue(
    'process-image',
    { fileId: 'f1' },
    {
        when: Date.now() + 5000, // schedule in the future
        priority: 10,
        tags: ['images', 'urgent'],
        bucket: 'gpu-workers',
        bucket_tokens: 1,
        max_tries: 3, // null = unlimited
        retry_delay: 2000,
        backoff_multiplier: 2.0,
        cron: '0 * * * *',
    },
);
```

Notes:

- `priority` is an integer; **lower numbers are claimed first** (`priority: 1` runs before `priority: 10`). Among equal priorities, earlier `when` goes first.
- `tags` can be a string or array of strings
- `bucket` and `bucket_tokens` integrate with token buckets
- `max_tries: 1` means “try once, then fail permanently”
- `max_tries: null` means unlimited retries (also honored as a job-type or queue default)
- `idempotency_key` dedups against a **live** job only (`pending` or `running`): enqueueing a key a
  live job holds returns that job's id and queues nothing. Every terminal state — done, failed,
  cancelled, claim timeout — releases the key, so the next enqueue with it creates a new job. A cron
  job keeps its key across occurrences (it never becomes terminal). With
  `idempotency_scope: 'pending'` the key is released at claim instead.
- the payload and the job row are written in **one transaction** — a duplicate or a lost race
  leaves no orphan payload behind

---

## Processing jobs with `process(...)`

Use a normal in-process consumer like this:

```javascript
const worker = okdb.queue.process(
    'send-email',
    async (payload, ctx) => {
        await ctx.markProgress('validating');

        if (!payload.to) throw new Error('missing recipient');

        await ctx.markProgress('sending');
        await sendEmail(payload.to, payload.subject);

        await ctx.okdb.put('email_log', payload.orderId, {
            to: payload.to,
            sentAt: Date.now(),
            jobId: ctx.jobId,
        });
    },
    {
        concurrency: 2,
        ttl: 30_000,
        onPermanentFail: async (job, err) => {
            console.error('permanently failed', job.id, err.message);
        },
    },
);
```

### Several types, one lane pool (array form)

Passing an **array of entries** runs several job types through ONE shared lane pool. Each
entry is exactly the single form folded into an object — `{ type, handler, ...perTypeOptions }`
— and the second argument becomes the **pool options** shared by every lane:

```javascript
const worker = okdb.queue.process(
    [
        { type: 'sync:forward', handler: forwardSync, weight: 3, ttl: 60_000 },
        { type: 'sync:backfill', handler: backfillSync, weight: 1, ttl: 300_000 },
        { type: 'content:page', handler: fetchPage },
    ],
    {
        concurrency: 4, // the PROCESS-WIDE cap: at most 4 handlers in flight across ALL types
        admission: () => okdb.pressure().score < 1, // load-aware: skip claiming under distress
    },
);
```

Why this exists: stacking N single-type consumers gives N _independent_ lane pools — a process
consuming 10 types at `concurrency: 2` each could run 20 handlers at once, with no total cap
and no cross-type fairness. The array form gives you:

- **One concurrency budget** across every type (the pool's `concurrency`).
- **Weighted fairness** — `weight` (default 1) biases the claim sweep, so under contention a
  weight-3 type gets ~3× the first-claim attempts of a weight-1 type; an idle type costs
  nothing.
- **One admission gate** — `admission: () => boolean` is consulted before every claim sweep;
  while it returns false the pool claims nothing (in-flight handlers finish normally, and the
  durable jobs remain claimable by other processes). Re-checked every `admissionInterval` ms
  (default 500). Combine with [`db.pressure()`](#load-aware-consumers) for a load-aware
  consumer in one line.

Per-type knobs (`ttl`, `autoHeartbeat`, `onPermanentFail`) live on the entry; cluster-wide
controls (`max_concurrency`, buckets, priority) keep working unchanged — they're enforced at
claim time regardless of consumer shape.

### Load-aware consumers

`db.pressure()` returns a composite load signal for this node, cached for 250 ms (safe to
poll per claim):

```javascript
{
    writerStallMs,  // max oldest-pending commit age across envs — THE stall tell
    writerDepth,    // max in-flight commit depth
    maxDurableLag,  // max durable processor lag (FTS/views/TM/embeddings behind)
    queuePending,   // pending+retry jobs across envs (workload, not in the score)
    loopLagMs,      // mean event-loop delay since the previous read
    score,          // max of the normalized distress signals; 1 ≈ at the limit
}
```

`admission: () => okdb.pressure().score < 1` makes a consumer yield to indexing/write load
automatically; an external autoscaler can poll the same read to decide when to add nodes.

### Handler signature

The handler receives:

```javascript
async (payload, ctx) => { ... }
```

Where `ctx` contains:

- `ctx.okdb` — the root `OKDB` instance
- `ctx.jobId` — queue job id
- `ctx.heartbeat()` — extend the claim TTL for long-running jobs
- `ctx.markProgress(message)` — update the job's `progress` field
- `ctx.log(message, level?)` — append a line to the job's log (current attempt)
- `ctx.signal` — an `AbortSignal`; see [Cancellation](#cancellation-ctxsignal)

### Cancellation (`ctx.signal`)

okdb never kills a running handler — cancellation is **cooperative**. `ctx.signal` is aborted
when the handler should stop, and `ctx.signal.reason` is an `OKDBError` whose `code` says why:

| `reason.code`     | When                                                                                                                                 | What happens to the job                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `JOB_CANCELLED`   | `cancelJob(id)` — at once in the cancelling process, at the next heartbeat (≤ ttl/3) elsewhere                                       | already `failed` / `cancelled`; the handler's outcome is ignored                                        |
| `CLAIM_LOST`      | the claim is gone: job removed, reclaimed after its claim expired (and maybe re-claimed by another consumer), or completed elsewhere | already owned by someone else (or gone); the handler's outcome is ignored                               |
| `WORKER_STOPPING` | `consumer.stop(timeout)` ran out of time with this handler still running                                                             | claim kept until the handler settles: resolved → `done`; threw → released to `pending`, try not counted |

```javascript
okdb.queue.process('export', async (payload, ctx) => {
    for (const chunk of plan(payload)) {
        ctx.signal.throwIfAborted(); // stop between steps
        await fetch(chunk.url, { signal: ctx.signal }); // or hand it to anything that accepts one
    }
});
```

A handler that ignores the signal simply runs to completion; after `JOB_CANCELLED` / `CLAIM_LOST`
its complete/fail is rejected (the job's state is already final or owned elsewhere). Queue-worker
engines (pipelines) pass the signal to the function sandbox, which aborts the function's own
`ctx.signal` and, if it doesn't unwind within the grace period, terminates it (`FUNCTION_CANCELLED`).

These local worker helpers now map to the same public queue API that remote workers can use:

- `okdb.queue.claim(type, options)`
- `okdb.queue.markJobHeartbeat(jobId, claimId, ttl?)`
- `okdb.queue.markJobProgress(jobId, claimId, message)`
- `okdb.queue.markJobComplete(jobId, claimId, result?)` — `result` (or a local handler's return
  value) is stored on the done job as `job.result` when JSON-serializable and ≤ 16 KB
- `okdb.queue.markJobFail(jobId, claimId, error, code?)`

### Placement: `process`

The queue is a **substrate okdb coordinates but does not place** — handlers are trusted user code
of unknown nature, so okdb never auto-runs them on a population. The surface is:

| Verb                      | Runs in               | 2nd arg       | Lifetime                |
| ------------------------- | --------------------- | ------------- | ----------------------- |
| `queue.process(type, fn)` | **this** Node process | a **closure** | dies with this instance |

`queue.process(type, closure)` is **the model** — single-execution and at-least-once come from
the CAS claim on the durable job row. Scale by running more independent processes: each opens
okdb and calls `process()`, and the durable CAS claim hands each job to exactly one consumer.
The canonical worker pattern is a standalone script (`workers/default.js`) launched by pm2,
systemd, or docker alongside your main service.

> **Removed:** `queue.worker(type, module)` — the auto-adopted "shared pool" form — throws
> `QUEUE_WORKER_REMOVED`. `queue.spawn(type, module)` — the dedicated forked child — was also
> removed in okdb 2.0. Run independent consumer processes instead; they claim the same durable
> jobs exactly once via CAS. See docs/upgrade-2.0.md for migration.

---

## The worker pattern

The canonical way to run queue consumers outside your main process:

```javascript
// workers/default.js — run alongside the main service
const OKDB = require('okdb');

async function main() {
    const okdb = new OKDB('./db');
    await okdb.open();

    okdb.queue.process(
        'send-email',
        async (payload, ctx) => {
            await sendEmail(payload.to, payload.subject);
        },
        { concurrency: 4 },
    );

    // okdb.queue.process('resize-image', async (payload, ctx) => { ... });

    process.on('SIGTERM', async () => {
        await okdb.close();
        process.exit(0);
    });
}

main().catch(console.error);
```

Launch it with pm2, systemd, docker, or kubernetes — run N replicas and each drains jobs via CAS
without coordination. A replica that dies leaves its in-flight jobs to re-queue on claim expiry.

---

## Worker options

### No polling — event-driven wakeup

A consumer does **not** poll. An idle lane sleeps on a wake handle and resumes immediately when work appears: a local `enqueue` (same process), a job finishing (frees a `max_concurrency` slot), or a cross-process queue write (the UDP bus POKE). The only timer is a long **backstop** (default 30 s, `OKDB_QUEUE_IDLE_MS`) that exists solely to cover a dropped bus POKE and to wake for time-scheduled jobs — the lane caps its sleep at the soonest future `when`, so delayed jobs still fire on time.

### `pollInterval`

Optional. When set, it **caps the idle backstop** for this consumer (an upper bound on wakeup latency if a bus POKE is ever dropped). It is no longer a poll cadence — leave it unset to get the default 30 s backstop with instant event-driven pickup.

```javascript
{
    pollInterval: 100;
}
```

### `concurrency`

How many jobs to process in parallel **inside the same process**.

```javascript
{
    concurrency: 4;
}
```

This is implemented as multiple independent claim/handle lanes.

### `ttl`

Claim timeout in ms.

```javascript
{
    ttl: 30_000;
}
```

If your worker dies or stops heartbeating, expired running jobs are re-queued by reconciliation.

### `onPermanentFail`

Called after a job permanently fails. For a cron job it fires when one occurrence fails for good
(the job itself recurs).

### Stopping a consumer: `stop(timeout)`

`consumer.stop(timeout = 30_000)` stops claiming and waits up to `timeout` ms for in-flight
handlers. Handlers still running after that get `ctx.signal` aborted (`WORKER_STOPPING`) and
`stop()` returns — but their claims are **kept** (and heartbeated) until each handler actually
settles: a job is never handed to another consumer while its handler is still running. When the
handler settles, its job is completed (it resolved) or released back to `pending` without burning
a try (it threw). If the process exits first, the claim is reclaimed by reconciliation — instantly
from a dead process on the same host, otherwise once the claim ttl expires — and the job re-runs
(at-least-once). `kill()` is `stop(0)`.

---

## Remote / external workers

If your workers run outside the embedded Node.js process, use the public queue lifecycle methods directly or call the equivalent HTTP endpoints.

### Public queue methods

```javascript
const claimed = await okdb.queue.claim('send-email', { ttl: 30_000 });
if (!claimed) return;

await okdb.queue.markJobProgress(claimed.id, claimed.claim_id, 'sending');

try {
    await sendEmail(claimed.payload.to, claimed.payload.subject);
    await okdb.queue.markJobComplete(claimed.id, claimed.claim_id, { delivered: true });
} catch (err) {
    await okdb.queue.markJobFail(claimed.id, claimed.claim_id, err, 'send_failed');
}
```

### Claim ownership contract

Remote lifecycle operations require the active `claim_id` returned by `claim(...)`.

- only the current claim holder may heartbeat, write progress, complete, or fail the job
- stale workers are rejected (`CLAIM_MISMATCH`) once the claim changes or expires
- this prevents duplicate workers from mutating the same running job

The HTTP routes reject a request without `claim_id` (400 `VALIDATION_ERROR`). In the **JS API**,
`markJobProgress`, `markJobComplete` and `markJobFail` (and their `completeJob`/`failJob` aliases)
throw `CLAIM_REQUIRED` when `claim_id` is `null`/omitted/empty, and `CLAIM_MISMATCH` when it is not
the job's current claim; `markJobHeartbeat` and `releaseClaim` also require it. `markJobHeartbeat`
**reports a lost claim** — it rejects with `NOT_FOUND` (job removed), `INVALID_STATE` (no longer
running: cancelled, completed, or reclaimed) or `CLAIM_MISMATCH` (re-claimed by someone else) —
so a remote worker learns to stop instead of heartbeating a job it no longer owns. (`appendJobLog`
still accepts `claim_id: null` to skip the ownership check — it only appends a log line.)

### HTTP endpoints for remote workers

The queue HTTP API now exposes the full remote-worker lifecycle:

- `POST /api/queue/claim/:type`
- `POST /api/queue/job/:id/heartbeat`
- `POST /api/queue/job/:id/progress`
- `POST /api/queue/job/:id/complete`
- `POST /api/queue/job/:id/fail`

Example:

```text
// claim
POST /api/queue/claim/send-email
{ "options": { "ttl": 30000 } }

// progress
POST /api/queue/job/<id>/progress
{ "claim_id": "<claim>", "progress": "sending" }

// complete
POST /api/queue/job/<id>/complete
{ "claim_id": "<claim>", "result": { "delivered": true } }

// fail
POST /api/queue/job/<id>/fail
{ "claim_id": "<claim>", "code": "send_failed", "message": "smtp timeout" }
```

---

## Job lifecycle

```text
pending → running → done
                └→ pending (retry)
                └→ failed
```

In more detail:

- `pending` — ready to be claimed
- `running` — claimed by a worker and currently in-flight
- `done` — completed successfully
- `failed` — permanently failed after all tries are exhausted, cancelled (`status_code: 'cancelled'`),
  or timed out with no tries left (`status_code: 'timeout'`)

When a running job's claim expires, reconciliation moves it back to `pending` (or to `failed` when
its tries are exhausted). A **cron** job never stays terminal: see [Cron support](#cron-support).

---

## Heartbeats and reconciliation

For long-running jobs, call `ctx.heartbeat()` periodically:

```javascript
okdb.queue.process(
    'import',
    async (payload, ctx) => {
        for (let i = 0; i < 10; i++) {
            await processChunk(i);
            await ctx.heartbeat();
            await ctx.markProgress(`chunk ${i + 1}/10`);
        }
    },
    { ttl: 5000 },
);
```

You can also manually trigger reconciliation:

```javascript
await okdb.queue._reconcile();
```

The admin UI also exposes reconcile actions.

---

## Listing jobs

```javascript
const { items, cursor } = await okdb.queue.list({
    type: 'send-email',
    status: 'pending',
    sort: 'when', // 'when' | 'priority'
    direction: 'asc',
    limit: 50,
    cursor: null,
});
```

Supported filters/options:

- `type`
- `status`
- `sort`
- `direction`
- `limit` (1–1000, default 50)
- `cursor`
- `tag` — jobs whose `tags` include this tag (any position, not just the first)
- `bucket` — jobs that draw from this bucket (`buckets[].id`, or the legacy `bucket` field)

**Paging.** `cursor` is an opaque string: pass the previous page's `cursor` to get the next page,
which starts strictly **after** the previous page's last row (no repeats, no gaps — also among jobs
sharing one `when`). It works with every `type` / `status` / `sort` / `direction` combination, and
is `null` on the last page. A cursor is bound to the type/status/sort it was issued for; reusing it
with a different one — or passing an index-key array cursor from an older version — throws
`BAD_PARAM` (restart with `cursor: null`).

```javascript
let cursor = null;
do {
    const page = await okdb.queue.list({ status: 'failed', limit: 100, cursor });
    for (const { value: job } of page.items) inspect(job);
    cursor = page.cursor;
} while (cursor);
```

`tag` and `bucket` are applied as filters over the `type`/`status` index scan: `limit` counts
matching jobs, and the scan continues until `limit` matches are found (or the index is exhausted),
so a rare tag over a large queue scans more rows.

---

## Getting and updating one job

### Get a job

```javascript
const job = await okdb.queue.getJob(jobId);

console.log(job.status);
console.log(job.payload);
console.log(job.progress);
```

`getJob()` returns job metadata **plus payload**.

### Update a job

```javascript
await okdb.queue.updateJob(jobId, {
    payload: { fileId: 'f1', force: true },
    priority: 9,
    tags: ['edited', 'manual'],
    progress: 'manually adjusted',
    status_message: 'edited from admin ui',
    retry_delay: 500,
});
```

Editable fields currently include:

- `type`
- `payload`
- `when`
- `priority`
- `tags`
- `bucket`
- `bucket_tokens`
- `cron`
- `max_tries`
- `retry_delay`
- `backoff_multiplier`
- `progress`
- `status_message`

---

## Retrying, removing, and clearing jobs

### Retry one job

```javascript
await okdb.queue.retryJob(jobId);
```

This resets the job back to `pending` and resets `tries` to `0`.

### Remove one job

```javascript
await okdb.queue.removeJob(jobId);
```

This deletes both the job metadata and its payload.

### Bulk cleanup helpers

```javascript
await okdb.queue.clearDone();
await okdb.queue.clearFailed();
await okdb.queue.clearStuck();
await okdb.queue.retryFailed();
```

Each method also accepts optional `type` and `limit` parameters.

---

## Buckets (token-bucket rate limiting)

Create a bucket:

```javascript
await okdb.queue.addBucket('gpu-workers', {
    capacity: 100,
    tokens: 100,
    refill_amount: 10,
    refill_every: 1000,
});
```

Update a bucket:

```javascript
await okdb.queue.updateBucket('gpu-workers', {
    tokens: 50,
    refill_amount: 20,
});
```

Remove a bucket:

```javascript
await okdb.queue.removeBucket('gpu-workers');
```

Manually claim tokens:

```javascript
const ok = await okdb.queue.tryClaimTokens('gpu-workers', 2);
```

Jobs can reference a bucket via `enqueue(..., { bucket, bucket_tokens })`.

---

## Cron support

`cron` expressions are evaluated with [croner](https://github.com/hexagon/croner) by default. To
use your own scheduler, configure `queue.cron_next`:

```javascript
const Croner = require('croner');

const okdb = new OKDB('./db', {
    queue: {
        cron_next: (expr, fromMs) => {
            return new Croner(expr, { currentDate: new Date(fromMs) }).nextRun().getTime();
        },
    },
});
```

Then enqueue recurring work:

```javascript
await okdb.queue.enqueue(
    'daily-report',
    { reportType: 'summary' },
    {
        cron: '0 8 * * *',
    },
);
```

A cron job is **one row that recurs**. Whichever way a run ends, the same write that ends it
re-queues the row as `pending` at the next cron time with `tries: 0`, recording how the run ended
in `job.last_run` (`{ status, status_code, status_message, tries, finished }`) and emitting
`queue:rescheduled` (not `queue:done` / `queue:failed`):

- **done** — `job.result` holds the run's result;
- **failed** — only after the run's own retries (`max_tries`) are used up; a retry re-runs the same
  occurrence first;
- **claim timeout** with no tries left (the consumer died) — `last_run.status_code: 'timeout'`.

Because the terminal row and the next occurrence are one write, a crash can't end the series.
**`cancelJob` is the only way to stop a series** (the job becomes `failed` / `cancelled`;
`retryJob` restarts it). If the next time can't be computed (invalid expression), the run's
terminal state is kept and a warning is logged.

---

## Events

Queue lifecycle events are emitted on **`okdb.events`**, not on `okdb.queue.events`.

Current low-frequency emitted events include:

- `queue:enqueued`
- `queue:done`
- `queue:failed`
- `queue:retry`
- `queue:rescheduled` — a cron run ended and the job is pending for its next occurrence
  (`{ id, type, when, outcome, status_code }`)
- `queue:removed`
- `queue:reconciled`

Example:

```javascript
okdb.events.on('queue:done', ({ id, type }) => {
    console.log('done', id, type);
});

okdb.events.on('queue:failed', ({ id, type, status_code }) => {
    console.log('failed', id, type, status_code);
});
```

### About filtering by type or key

Today, filtering by job type or job id is best done in your handler:

```javascript
okdb.events.on('queue:done', (ev) => {
    if (ev.type !== 'send-email') return;
    console.log('email job done', ev.id);
});
```

If a richer queue-specific event subscription API is added later, it will likely build on top of these base events.

---

## Sync behaviour

Queue data lives in the current environment, so it replicates with that environment (every user environment takes part in sync).

That means:

- a job enqueued in a synced env can replicate to peers
- a worker on another node/process can consume from the same synced data
- retry/failure state also follows the same environment data

If you want queue isolation, use a separate environment for it.

---

## Queue-worker engine

For persistent, self-managing workers that use stored functions, see **queue-worker engines** in [Pipelines](./pipelines.md).

The queue-worker engine is a pipeline-compatible engine type that:

- claims jobs from the queue automatically
- invokes a stored function for each claimed payload
- handles completion/failure using normal queue semantics

Worker `concurrency` controls job throughput. Each invoked function runs in the executing node's local sandbox thread (lazy, idle-reaped) — no pool to size.

---

## Admin UI

The admin queue UI supports:

- filtering by status and type
- retry / cancel / delete
- bulk clear / bulk retry actions
- viewing progress
- editing payload and queue settings for a job

Expanded rows show key metadata, and the edit dialog allows modifying payload and most queue settings without editing raw `~queue_jobs` records directly.
