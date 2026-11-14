# Autonomous Code Reviewer: Implementation Plan

> Portfolio P2 (W06, Multi-Agent). Four specialist agents (Security, Style, Coverage, Architecture) review every PR in parallel. A Claude judge merges their findings into one verdict, and the result is posted back as a GitHub review. Deployed on Fly.io.

---

## 1. What "done" looks like

When someone opens or pushes to a PR in a connected repo, a review from `ai-reviewer[bot]` shows up within about 2 minutes. It contains:

- an overall verdict (`REQUEST_CHANGES` or `COMMENT`) with severity counts
- a per-agent breakdown table (what Security, Style, Coverage and Architecture each found, and what the judge kept or dropped)
- inline comments on the exact changed lines, each with a severity, a rationale and a suggested fix

The demo also needs to show the numbers behind it: precision and recall on a labelled PR set, cost per PR, p50/p95 latency, and a before/after review-time comparison on a pilot repo. That comparison is what backs up the "cuts review time by 70%" claim. Until it is measured, treat 70% as a target.

---

## 2. Architecture

```
 PR opened / synchronize
          │
 ┌────────▼─────────┐   POST /hooks/pr (OIDC JWT)    ┌──────────────────────────┐
 │ GitHub Actions   │ ─────────────────────────────▶ │ Fly app: web (Fastify)   │
 │ ai-review.yml    │   {repo, pr, base, head, cov?} │ verify → enqueue → 202   │
 └──────────────────┘                                └────────────┬─────────────┘
                                                                  │ BullMQ FlowProducer
                                                     ┌────────────▼─────────────┐
                                                     │ Redis (Upstash on Fly)   │
                                                     └────────────┬─────────────┘
                                                                  │
 ┌────────────────────────────── Fly app: worker ─────────────────▼─────────────────────────┐
 │ 1. prepare   GitHub App token → PR files + head contents → Tree-sitter → ReviewContext   │
 │ 2. agents    ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────────┐   (child jobs,     │
 │              │ Security │ │ Style/Lint│ │ Coverage │ │ Architecture │    run in parallel) │
 │              └────┬─────┘ └─────┬─────┘ └────┬─────┘ └──────┬───────┘                    │
 │ 3. judge     dedupe → verify against code → final severity → verdict  (parent job)       │
 │ 4. publish   POST /repos/{o}/{r}/pulls/{n}/reviews  (summary + inline comments)          │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
                                                                  │
                                                     Postgres: runs, findings, cost, feedback
```

### Key design decisions

| Decision | Choice | Why |
|---|---|---|
| Trigger | GitHub Actions workflow POSTs to the service (as the spec says) | Easy to install per repo, and the Action can also attach coverage output (lcov) |
| Trigger auth | GitHub Actions **OIDC token**, verified against GitHub's JWKS | No shared secret to leak or rotate; the token proves which repo and workflow sent it |
| GitHub API identity | **GitHub App** (installation tokens) | Comments come from a bot identity with least-privilege scopes: `pull_requests: write`, `contents: read`, `checks: write` |
| Queue topology | BullMQ **FlowProducer**: parent `judge` job with 4 `agent` child jobs | Parallelism, per-agent retries, and the judge starts automatically when the children finish. `ignoreDependencyOnFailure` lets the judge run with 3 of 4 agents |
| Idempotency | jobId = `owner/repo#pr@headSha`; a new push removes queued jobs for older SHAs | Prevents duplicate reviews and wasted spend on superseded commits |
| Parsing | `web-tree-sitter` (WASM) + grammars for TS/JS, Python, Go | WASM needs no native build in Docker. You can't parse a diff directly, so parse the **full head-version files** and map hunks to the symbols that contain them |
| Agent shape | One structured-output Claude call per agent (no tool loop in v1) | Predictable cost and latency; findings come back schema-validated |
| Debate | v1: the judge does the cross-examination. v1.1: optional rebuttal round, A/B tested on the eval set | Ship the simple version first and keep the extra round only if the evals show it helps |
| Storage | Postgres + Prisma | You already use this stack; it's needed for metrics, feedback and the 70% claim |

---

## 3. Components

### 3.1 GitHub Action (`action/ai-review.yml`)
- Triggers on `pull_request: [opened, synchronize, reopened, ready_for_review]`. Skips drafts.
- Uses `permissions: id-token: write`, then calls `core.getIDToken('ai-reviewer')` and POSTs `{owner, repo, pr, baseSha, headSha}`.
- Optional step: run the repo's tests with coverage and send a compressed lcov summary of changed files only.
- **Fork PRs:** `pull_request` from a fork gets no OIDC token. Use `pull_request_target` for forks. That's safe here because the Action **never checks out or runs PR code**, it only sends metadata.

### 3.2 Web service (`src/server`)
- Fastify. `POST /hooks/pr` verifies the JWT (`iss`, `aud`, and a `repository` allow-list), validates the body with Zod, adds the job flow, and returns `202 {runId}`.
- `GET /healthz`, plus Bull Board at `/admin/queues` behind basic auth.

### 3.3 Prepare step: Tree-sitter context builder (`src/parser`)
1. `GET /pulls/{n}/files` (paginated). Drop lockfiles, generated, vendored and binary files, and anything over the size limit.
2. Fetch the head-SHA contents of each remaining file and parse it with the language grammar.
3. Build a **ReviewContext** for each hunk:
   - the containing function/class (name, signature, full body)
   - the changed lines with their **new-file line numbers**, which inline comments need
   - the file's imports/exports
   - a repo map of top-level symbols for the touched modules (used by the Architecture agent)
   - the list of test files changed alongside source files (used by the Coverage agent)
4. Token budget: count tokens with `messages.count_tokens`. If the context is over budget, split it into file groups and run the agents once per chunk; the judge merges the results. Never truncate silently. If a PR is too large, the summary says which files were skipped.
5. Store the context in Redis under `runId`, so child jobs receive a reference instead of the whole payload.

### 3.4 Agents (`src/agents`)
All four agents return the same Zod schema, converted to JSON Schema for structured outputs (`output_config.format`):

```ts
Finding = {
  file: string; line: number; endLine?: number;      // must point into a RIGHT-side diff hunk
  severity: "critical" | "high" | "medium" | "low" | "nit";
  category: string;                                   // e.g. "sql-injection", "missing-test"
  title: string; rationale: string; suggestion?: string;
  confidence: number;                                 // 0–1
}
AgentReport = { agent: AgentName; summary: string; findings: Finding[] }
```

| Agent | Looks at | Extra deterministic inputs |
|---|---|---|
| **Security** | injection, authn/z gaps, secrets, unsafe deserialization, SSRF, path traversal, unsafe dependency additions | Regex secret scan and dangerous-API grep, passed in as hints |
| **Style & Lint** | naming, dead code, complexity, consistency with the repo's conventions | The repo's `.eslintrc`, `prettier` and `ruff` configs, included as context |
| **Test Coverage** | changed or new symbols with no matching test changes; untested branches | lcov from the Action, if sent: changed lines marked as uncovered |
| **Architecture** | layering violations, new cross-module dependencies, cycles, leaky abstractions, API breaks | Import graph and repo map from Tree-sitter |

**Prompt-injection defence:** PR content goes inside delimited tags and is described as untrusted data. Agents have no tools and can only emit schema-validated findings, so injected text can't trigger any action beyond a bad comment, and the judge plus line validation filter those out.

### 3.5 Judge (`src/judge`)
- Input: the 4 `AgentReport`s plus the code around every referenced line.
- Tasks: merge duplicates across agents, **check each finding against the actual code** (drop ones it can't support), set the final severity using a written rubric, and write the summary.
- Deterministic post-check: any finding whose `line` isn't in a RIGHT-side hunk moves to the summary body instead of becoming an inline comment, because GitHub returns a 422 for those.
- Verdict rule (in code, not left to the model): any confirmed `critical`/`high` gives `REQUEST_CHANGES`; anything else gives `COMMENT`. `APPROVE` is off by default and configurable per repo.

### 3.6 Publisher (`src/github/review.ts`)
- One `POST /pulls/{n}/reviews` call with `commit_id = headSha`, `event`, a markdown `body` and `comments[]` (`path`, `line`, `side: "RIGHT"`, `body`).
- At most 15 inline comments, ordered by severity; the rest go into a collapsible `<details>` section of the summary.
- The body includes the hidden marker `<!-- ai-reviewer run=… sha=… -->`. Before posting, check for an existing review with the same SHA and skip if there is one.
- Optional: a Check Run with the same verdict, so branch protection can use it.

### 3.7 LLM layer (`src/llm`)
- `@anthropic-ai/sdk`, model **`claude-opus-5-5`** for all five calls. The four agents share **one** top-level effort (`medium`) and the judge uses `high`. A different top-level effort per agent would invalidate the shared messages cache; if per-agent effort is needed later, use the per-message effort system message (beta) and measure it. (Moving the specialists to `claude-sonnet-5-5` or `claude-haiku-5-5` is a cost lever. Decide that from eval results, not upfront.)
- **Prompt caching across the 4 agents:** they all see the same PR context, so the request is laid out as shared system prompt, then a user message with the ReviewContext (`cache_control` breakpoint), then a **mid-conversation system message** with the agent-specific role and rubric. All four use the same output schema. A `max_tokens: 0` pre-warm isn't possible here because the API rejects it together with structured outputs. Instead, launch in parallel and measure `cache_read_input_tokens`; if parallel calls miss, start one agent first and the other three after it. Details: `acr-llm` skill.
- Refusal handling: check `stop_reason` before reading content, and enable server-side `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`).
- Typed error handling: retry on 429/5xx through BullMQ backoff, fail fast on 400.
- Record `usage` (input, output and cache-read tokens) for every call in Postgres, so cost per PR is a real number.

### 3.8 Data model (Prisma)
`Installation`, `ReviewRun` (repo, pr, sha, status, latency, cost, verdict), `AgentReport`, `Finding` (with `keptByJudge`, `finalSeverity`, `githubCommentId`), `Feedback` (👍/👎 reactions on bot comments, polled later; gives a precision signal from production).

---

## 4. Repo layout

```
src/
  server/        index.ts, routes/hook.ts, auth/oidc.ts
  queue/         connection.ts, flows.ts, names.ts
  worker/        index.ts, processors/{prepare,agent,judge,publish}.ts
  github/        app-auth.ts, pr-files.ts, review.ts
  parser/        treesitter.ts, grammars/*.wasm, diff-map.ts, context-builder.ts, repo-map.ts
  agents/        base.ts, security.ts, style.ts, coverage.ts, architecture.ts, prompts/*.md
  judge/         judge.ts, rubric.md, verdict.ts
  llm/           client.ts, caching.ts, cost.ts
  render/        review-markdown.ts
  schemas/       finding.ts, hook.ts
action/          ai-review.yml
evals/           fixtures/<case>/{diff.patch, files/, expected.json}, run-eval.ts, report.ts
prisma/          schema.prisma
test/            unit + integration (nock GitHub, recorded LLM responses)
Dockerfile  fly.toml  .env.example
```

---

## 5. Build phases

| # | Phase | Deliverable / exit criteria | Est. |
|---|---|---|---|
| 0 | **Setup** | TS + ESLint + Vitest, Dockerfile, a GitHub App created on a sandbox repo, local Redis via docker compose | 0.5 d |
| 1 | **Walking skeleton** | Action → `/hooks/pr` (OIDC verified) → BullMQ → worker posts a stub "hello" review on the PR. The whole path works with no AI yet | 1 d |
| 2 | **Context builder** | Tree-sitter for TS/JS (Python and Go next); hunk-to-symbol mapping; line-number mapping unit-tested against real diffs; token budgeting and chunking | 1.5 d |
| 3 | **Agents** | 4 agents with structured output, prompts, deterministic hints, caching layout; FlowProducer fan-out; per-agent retries | 2 d |
| 4 | **Judge + publisher** | Dedupe and verification, verdict rule, markdown renderer with per-agent table, inline comments, idempotency marker, 422-safe line validation | 1.5 d |
| 5 | **Eval harness** | 25–30 fixture PRs: ~20 with seeded issues across the 4 categories, ~8 clean (to measure false positives). `npm run eval` reports precision, recall, cost and latency per agent | 1.5 d |
| 6 | **Deploy** | Fly app with `[processes] web/worker`, Upstash Redis (`fly redis create`), Postgres (Fly or Neon), `fly secrets`, health checks, Bull Board | 1 d |
| 7 | **Hardening** | Supersede old SHAs, fork-PR path, rate-limit handling, structured logs, cost guardrail (skip or chunk PRs over N tokens), README with architecture diagram | 1 d |
| 8 | **Proof + demo** | Run on a pilot repo for a week; collect review-time metrics and 👍/👎 rates; record a demo video; optional v1.1 rebuttal round compared against v1 on the eval set | 1–2 d |

About 11–12 working days in total. Phases 2 and 3 can overlap once the `ReviewContext` type is fixed.

---

## 6. Evaluation and the 70% claim

- **Offline (each prompt change):** precision and recall per agent on the fixture set, false positives on clean PRs, judge drop rate, schema-failure rate, cost and latency. Re-run the eval before merging any prompt change.
- **Online:** 👍/👎 per comment, how many comments lead to a follow-up commit touching the same lines, and time from PR open to first review.
- **Business impact:** on a pilot repo, compare median *human review time* (first human review to approval) and *review rounds per PR* for 2 weeks before and after. Report the measured number; "70%" is the hypothesis being tested.

**Rough cost** (a typical 20k-token PR context on Opus 5.5 at $4/$20 per MTok): about $0.60/PR without caching, and roughly half that with the shared-prefix cache. Confirm with real `usage` data in phase 5.

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hallucinated findings or wrong line numbers | Judge checks findings against the code; deterministic hunk validation; confidence threshold; inline comment cap |
| Comment noise annoys developers | Severity-ordered cap, nits folded into the summary, per-repo config (`.ai-reviewer.yml`: disabled agents, ignore paths, minimum severity) |
| Large PRs blow the budget | Token counting, chunking, skip lists, a clear "partially reviewed" note |
| Prompt injection inside PR content | Delimited untrusted data, no agent tools, schema-only output, judge filtering |
| Upstash + BullMQ quirks | `maxRetriesPerRequest: null` on the ioredis connection; fixed-price Upstash plan (BullMQ polls, so per-command pricing adds up) |
| Fork PRs lack secrets/OIDC | `pull_request_target` path that only sends metadata and never runs PR code |
| GitHub secondary rate limits | One review POST per run, installation-token caching, BullMQ rate limiter per installation |

---

## 8. Open decisions (defaults in bold)

1. **Model tiering:** **all agents on `claude-opus-5-5` with effort set per role**, or move specialists to Sonnet 5.5 / Haiku 5.5 after evals.
2. **Languages at launch:** **TS/JS first**, then Python and Go.
3. **Allow `APPROVE`:** **no**. The bot only comments or requests changes.
4. **Debate round:** **judge-only in v1**, with the rebuttal round as a measured v1.1 experiment.
