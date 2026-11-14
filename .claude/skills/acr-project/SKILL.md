---
name: acr-project
description: >-
  Autonomous Code Reviewer (ACR): four Claude specialist agents (Security, Style,
  Coverage, Architecture) review every GitHub PR in parallel, a Claude judge merges
  their findings, and the result is posted as a GitHub review. TypeScript, Fastify,
  BullMQ, Tree-sitter, Prisma, Fly.io. Start here for architecture, repo layout,
  conventions, commands, and which acr-* skill covers which part of the code.
---

# Autonomous Code Reviewer: start here

Portfolio P2 (W06, Multi-Agent). The source of truth for scope and phases is `PLAN.md`
at the repo root. This skill is the map. The `acr-*` skills hold the detail for each part.

> **Status: pre-code.** These skills describe the *target* design from PLAN.md. When the
> code diverges (a file moves, a decision changes), update the skill in the same change.
> A stale skill sends the agent to the wrong place.

## Architecture

```
GitHub Action ──OIDC JWT──▶ web (Fastify) ──▶ BullMQ/Redis ──▶ worker
                            POST /hooks/pr     prepare → [security|style|coverage|architecture] → judge → publish
                                                                                                     │
                                                         GitHub REST: one review + inline comments ◀─┘
                                                         Postgres: runs, findings, usage/cost, feedback
```

- **One Fly app, two process groups:** `web` (receives requests, returns 202) and `worker` (does all the work).
- **The web process never calls GitHub content APIs or Claude.** It verifies, enqueues and returns.
- **Agents are single structured-output calls** (no tool loop in v1). The judge is a separate call.
- **Code makes the final verdict decision, not the model.** See `acr-judge`.

## Stack

| Concern | Choice |
|---|---|
| Language | TypeScript (ESM, `"type": "module"`), Node 22 |
| HTTP | Fastify |
| Queue | BullMQ + ioredis (Upstash Redis via `fly redis create`) |
| Parsing | `web-tree-sitter` (WASM grammars vendored in `src/parser/grammars/`) |
| LLM | `@anthropic-ai/sdk`, model `claude-opus-5-5` |
| GitHub | GitHub App via `@octokit/app` (installation tokens) |
| Validation | Zod: every boundary (hook body, job payloads, LLM output, env) |
| DB | Postgres + Prisma |
| Tests | Vitest (unit + integration), real Redis via docker compose for queue tests |
| Deploy | Fly.io (`fly.toml` `[processes]`) |

## Repo layout (target)

```
src/server/     Fastify app, /hooks/pr, OIDC verification          → acr-trigger
src/queue/      Redis connection, queue names, flow builder         → acr-queue
src/worker/     processors: prepare, agent, judge, publish          → acr-queue
src/github/     App auth, PR files/blobs, review + check publishing → acr-github
src/parser/     tree-sitter, diff → RIGHT-line map, ReviewContext   → acr-parser
src/agents/     4 agents, prompts/*.md, deterministic hints         → acr-agents
src/llm/        Anthropic client, caching layout, usage → cost      → acr-llm
src/judge/      merge/verify, rubric.md, verdict.ts                 → acr-judge
src/render/     review markdown                                     → acr-judge
src/schemas/    Zod: Finding, AgentReport, HookBody, job payloads
action/         ai-review.yml (installed into target repos)         → acr-trigger
evals/          fixture PRs, runner, baseline                       → acr-evals
prisma/         schema.prisma                                       → acr-database
test/           vitest unit + integration                           → acr-testing
Dockerfile, fly.toml                                                → acr-deploy
```

## Skill index

| Task | Skill |
|---|---|
| Orient, conventions, commands | `acr-project` (this file) |
| Executing a PLAN.md phase, done-gates | `acr-phase` (+ generic `parallel-phase-shipping`) |
| GitHub Action, `/hooks/pr`, OIDC | `acr-trigger` (+ `harden-webhook-endpoint`) |
| GitHub App auth, fetching PR files, posting reviews | `acr-github` |
| Queues, flows, retries, superseding, shutdown | `acr-queue` (+ `bullmq-specialist`) |
| Tree-sitter, hunk mapping, ReviewContext, token budget | `acr-parser` |
| Specialist agent prompts, Finding schema, hints | `acr-agents` (+ `code-review-excellence`) |
| Anthropic SDK calls, caching, refusals, cost | `acr-llm` (+ global `claude-api`) |
| Judge, verdict rule, review markdown | `acr-judge` |
| Fixture PRs, precision/recall, regressions | `acr-evals` |
| Prisma models, migrations | `acr-database` (+ `prisma-expert`) |
| Fly.io, Redis, secrets, smoke test | `acr-deploy` (+ `idle-cost-audit`) |
| Writing tests, fakes for GitHub/LLM | `acr-testing` |
| CI workflow for this repo | `setting-up-ci` |
| Any failure or unexpected behaviour | `systematic-debugging` |

## Non-negotiables

1. **Never run PR code.** We read diffs and file contents only. The Action never checks out the PR head.
2. **PR content is untrusted data.** It goes into prompts inside delimited tags and is never followed as instructions (`acr-agents`).
3. **No live Anthropic or GitHub calls in `npm test`.** Use the fakes (`acr-testing`). Live calls cost money and are slow, so they only happen in `npm run eval` and on the sandbox repo.
4. **Any change to a prompt, rubric, schema or model setting needs an eval run** compared against `evals/baseline.json` before it's done (`acr-evals`). Ask the user before running evals: they bill real money.
5. **Validate every boundary with Zod.** That covers hook bodies, job payloads, LLM output and `process.env` (via `src/env.ts`).
6. **Idempotent by `(owner, repo, pr, headSha)`.** Re-delivery or retries must never post a second review for the same SHA.
7. **Secrets come only from env.** Never log tokens, JWTs, private keys or full prompts. Log run IDs and counts.
8. **Model ID is `claude-opus-5-5`, set in `src/llm/models.ts` only.** Don't scatter model strings.

## Commands (contract that Phase 0 must create in package.json)

```bash
npm run dev:web          # tsx watch src/server/index.ts   (port 8080)
npm run dev:worker       # tsx watch src/worker/index.ts
npm run typecheck        # tsc --noEmit
npm run lint             # eslint .
npm test                 # vitest run (unit, no network)
npm run test:integration # vitest run --project integration (needs docker compose up redis)
npm run eval             # evals/run-eval.ts (LIVE Claude calls, so ask first)
npm run db:migrate       # prisma migrate dev
npm run build            # tsc -p tsconfig.build.json → dist/
docker compose up -d redis postgres
```

**Done means:** `npm run typecheck && npm run lint && npm test` is green, and also
`npm run test:integration` if you touched queue or server code.

## Environment (`src/env.ts`, Zod-parsed)

`ANTHROPIC_API_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_B64`, `REDIS_URL`,
`DATABASE_URL`, `OIDC_AUDIENCE` (default `ai-reviewer`), `ALLOWED_OWNERS` (comma list),
`BULL_BOARD_USER`, `BULL_BOARD_PASSWORD`, `LOG_LEVEL`. Keep `.env.example` in sync.

## Open decisions (PLAN.md §8)

Defaults: all agents on Opus 5.5, TS/JS first, the bot never sends `APPROVE`, and v1
uses the judge alone (no debate round). Don't change these without the user's say-so.
