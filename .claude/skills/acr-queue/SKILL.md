---
name: acr-queue
description: >-
  BullMQ design for ACR: the prepare job, the FlowProducer tree (four agent children
  under judge under publish), job IDs and idempotency, superseding older commits,
  retries and unrecoverable errors, rate limits, Upstash/Fly Redis connection settings,
  Bull Board, and graceful shutdown. Use when editing src/queue/ or src/worker/,
  adding a processor, or debugging stuck, duplicate or failed jobs.
---

# Queue and worker (src/queue, src/worker)

Generic BullMQ expertise: `bullmq-specialist`. This file is the ACR-specific design.

## Pipeline

```
/hooks/pr ──add──▶ [prepare]                        (plain queue)
                      │ builds ReviewContext → Redis key ctx:<runId>
                      └─ FlowProducer.add(tree) ──▶
                           [publish]                      parent  (runs last)
                              └─ [judge]                  child of publish
                                   ├─ [agent] security    children of judge
                                   ├─ [agent] style       (run in parallel)
                                   ├─ [agent] coverage
                                   └─ [agent] architecture
```

Why prepare is not part of the tree: a flow child can't have four parents, and the four
agents all need the context. Prepare runs, stores the context, then adds the flow.
Publish is separate from judge so a GitHub failure retries **without re-paying for the judge**.

## Names and IDs (src/queue/names.ts)

```ts
export const Q = { prepare: "acr-prepare", agent: "acr-agent", judge: "acr-judge", publish: "acr-publish" } as const;
export const runKey = (r: PrRef & { headSha: string }) =>
  `${r.owner}__${r.repo}__${r.pr}__${r.headSha.slice(0, 12)}`;   // no ":" (BullMQ's key separator)
```

- `runId = runKey(...)`. Prepare jobId = `runId`. Agent jobIds = `${runId}__${agent}`, and so on.
  Adding an existing jobId is a no-op, which gives free dedupe for re-delivered hooks.
- Payloads are Zod-parsed at the top of every processor (`src/schemas/jobs.ts`). Pass
  **references** (`runId`, Redis keys), not the ReviewContext itself.

## Flow (src/queue/flows.ts)

```ts
const agentChild = (agent: AgentName) => ({
  name: agent, queueName: Q.agent, data: { runId, agent },
  opts: {
    jobId: `${runId}__${agent}`,
    attempts: 3, backoff: { type: "exponential", delay: 5_000 },
    ignoreDependencyOnFailure: true,   // judge still runs with 3/4 reports
  },
});

await flowProducer.add({
  name: "publish", queueName: Q.publish, data: { runId }, opts: { jobId: `${runId}__publish`, attempts: 5 },
  children: [{
    name: "judge", queueName: Q.judge, data: { runId }, opts: { jobId: `${runId}__judge`, attempts: 2 },
    children: AGENTS.map(agentChild),
  }],
});
```

In the judge: `await job.getChildrenValues()` returns the AgentReports, and
`await job.getIgnoredChildrenFailures()` returns the failed agents (BullMQ ≥ 5; check the
installed version). Name the missing agents in the review summary ("Coverage agent
unavailable"). If **all four** failed, publish nothing and mark the run failed.

## Superseding older SHAs

Set `latest:<owner>/<repo>#<pr>` = headSha in prepare. **Every processor checks it first**
and returns `{ superseded: true }` without calling Claude or GitHub if it doesn't match.
That's cheaper and simpler than hunting down and removing queued jobs.

## Errors and retries

- Retryable (throw a normal Error): Anthropic `RateLimitError`, 5xx, `APIConnectionError`; GitHub 403/429/5xx.
- **Not retryable:** throw `UnrecoverableError` from `bullmq` for Anthropic `BadRequestError`,
  Zod failures on our own payloads, an uninstalled App, or a closed PR.
- An LLM output that fails the schema gets **one** in-process retry with the validation error
  appended. After that, fail the agent job (the judge proceeds without it).

## Concurrency and limits

```ts
new Worker(Q.agent, agentProcessor, { connection, concurrency: 8, limiter: { max: 40, duration: 60_000 } });
new Worker(Q.judge, judgeProcessor, { connection, concurrency: 4 });
new Worker(Q.publish, publishProcessor, { connection, concurrency: 4 });
```

Tune `limiter` to the Anthropic tier's RPM. Default job opts: `removeOnComplete: { count: 1000 }`,
`removeOnFail: { count: 5000 }`.

## Redis connection (src/queue/connection.ts)

```ts
import { Redis } from "ioredis";
export const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,   // required by BullMQ workers
  family: 6,                    // Fly private network (Upstash via `fly redis create`) is IPv6
});
```

Locally, `family: 6` can break `localhost`. Make it `env.REDIS_FAMILY` (default 4 in dev).

**Cost:** idle BullMQ workers still poll Redis. On per-command Upstash pricing that bills
24/7. Use a fixed-price plan or raise `drainDelay` / `stalledInterval`. If the Redis bill
looks wrong, run `idle-cost-audit`.

## Shutdown (src/worker/index.ts)

On `SIGTERM`/`SIGINT`: `await Promise.all(workers.map(w => w.close()))`, then
`await flowProducer.close()`, then `await connection.quit()`, then exit. Fly sends SIGINT
by default, so set `kill_signal = "SIGTERM"` and `kill_timeout = 60` in fly.toml
(`acr-deploy`) so in-flight Claude calls can finish.

## Testing

Queue tests use **real Redis** (docker compose) in `test:integration`, with a unique
queue prefix per test file. Assert: a duplicate hook means one prepare job; one agent
failing means the judge still runs and the summary names it; a superseded SHA means no
Claude or GitHub calls (fakes record calls).
