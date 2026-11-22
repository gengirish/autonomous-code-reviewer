---
name: acr-database
description: >-
  ACR's Postgres + Prisma data model: review runs, agent reports, findings, LLM call
  usage/cost, feedback reactions; migrations and connection settings. Use when editing
  prisma/schema.prisma, writing queries for metrics or dashboards, adding a model or
  field, or running migrations.
---

# Database (prisma/)

General Prisma expertise: `prisma-expert`. Redis holds transient state (queues, the
ReviewContext). **Postgres holds the permanent record** used for metrics, feedback and the
70% claim.

## Models (target schema)

```prisma
model ReviewRun {
  id          String   @id                // = runId from acr-queue
  owner       String
  repo        String
  pr          Int
  headSha     String
  status      RunStatus @default(QUEUED)  // QUEUED | RUNNING | PUBLISHED | SUPERSEDED | FAILED
  verdict     String?                     // REQUEST_CHANGES | COMMENT | APPROVE
  reviewId    BigInt?                     // GitHub review id
  chunks      Int      @default(1)
  costUsd     Decimal? @db.Decimal(10, 4)
  latencyMs   Int?
  error       String?
  createdAt   DateTime @default(now())
  finishedAt  DateTime?
  reports     AgentReport[]
  findings    Finding[]
  llmCalls    LlmCall[]
  @@unique([owner, repo, pr, headSha])
  @@index([owner, repo, pr])
}

model AgentReport {
  id       String  @id @default(cuid())
  runId    String
  run      ReviewRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  agent    String                         // security | style | coverage | architecture
  chunk    Int     @default(0)
  status   String                         // ok | failed | refused | skipped
  summary  String?
  @@index([runId])
}

model Finding {
  id              String  @id @default(cuid())
  runId           String
  run             ReviewRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  sourceAgents    String[]
  file            String
  line            Int
  category        String
  agentSeverity   String
  finalSeverity   String
  kept            Boolean
  dropReason      String?
  inline          Boolean @default(false)
  githubCommentId BigInt?
  title           String
  feedback        Feedback[]
  @@index([runId])
  @@index([category])
}

model LlmCall {
  id               String  @id @default(cuid())
  runId            String
  run              ReviewRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  role             String                 // agent name or "judge"
  model            String
  inputTokens      Int
  outputTokens     Int
  cacheReadTokens  Int
  cacheWriteTokens Int
  stopReason       String
  latencyMs        Int
  costUsd          Decimal @db.Decimal(10, 5)
  createdAt        DateTime @default(now())
  @@index([runId])
}

model Feedback {
  id         String  @id @default(cuid())
  findingId  String
  finding    Finding @relation(fields: [findingId], references: [id], onDelete: Cascade)
  reaction   String                       // "+1" | "-1"
  githubUser String                       // login only; no other PII
  createdAt  DateTime @default(now())
  @@unique([findingId, githubUser, reaction])
}
```

**Don't store** the full prompts, the code contents or the model's raw output. Store IDs,
counts, titles and locations. Code belongs to the target repos.

## Conventions

- Prisma Client is used by the **worker** (write path) and admin/metrics scripts. The web
  process only writes the initial `QUEUED` row (or nothing; it's fine to create the row in prepare).
- The web process gets `createDbFromEnv()` → `{ recorder, stats, close }` (one pool for both).
  `stats` is the `StatsReader` port (`src/db/stats.ts`): typed `reviewRun.aggregate` only,
  never `$queryRawUnsafe`. Routes never call `createPrisma` themselves.
- Writes are upserts keyed by `runId` so BullMQ retries are safe.
- Money is `Decimal`, never float.
- Connection: in production use the pooled URL (Neon pooler or Fly Postgres via PgBouncer)
  with `connection_limit` sized to worker concurrency. Set `DIRECT_URL` for migrations.

## Commands

```bash
npm run db:migrate                   # prisma migrate dev --name <change>
npx prisma migrate deploy            # production (run from a release_command, see acr-deploy)
npx prisma studio                    # local inspection
```

Every schema change: migration + update this file + update `acr-evals` report fields if
metrics change.
