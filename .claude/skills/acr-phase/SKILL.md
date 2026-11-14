---
name: acr-phase
description: >-
  How to execute a phase of the Autonomous Code Reviewer PLAN.md (phase 0 setup through
  phase 8 proof/demo): break it into features, decide what runs in parallel, and apply
  the ACR done-gate before marking anything complete. Use when the user says "start
  phase N", "build the next phase", "continue the plan", "what's left", or asks to
  implement a PLAN.md milestone.
---

# Executing a PLAN.md phase

The generic rhythm comes from `parallel-phase-shipping`: phases run in sequence, the
features inside a phase run in parallel where they're independent, and every feature
has to pass a gate. That skill's examples are ChairOS/Vercel. **This file overrides
its gate with ACR-specific stations.**

## Before starting a phase

1. Read the phase row in `PLAN.md` §5 and the sections it depends on.
2. Check the previous phase is marked ✅ in PLAN.md. If not, finish it first.
3. Write the feature list with TodoWrite. Mark each feature `[par]`, `[seq]` or `[gate]`.
4. Load the `acr-*` skills for the parts of the code the phase touches (see `acr-project`).

## Prerequisite: git

The repo is initialised locally on `main`, with `.gitignore` in place. There's **no remote
yet**: creating the GitHub repo and pushing are part of Phase 0, **after confirming with the
user**. Parallel subagents need git worktrees, so do **not** run parallel work in one checkout.

## ACR done-gate (per feature)

| # | Station | How |
|---|---|---|
| 1 | Scoped | It's a TodoWrite item with an exit criterion copied from PLAN.md |
| 2 | Implemented | Follow the relevant `acr-*` skill's conventions |
| 3 | Tests | Unit tests with fakes; integration tests for queue/server (`acr-testing`) |
| 4 | Static checks | `npm run typecheck && npm run lint && npm test` all green |
| 5 | Evals (only if prompts, rubric, schema or model settings changed) | `npm run eval`, **ask first** because it costs money; no regression vs `evals/baseline.json` (`acr-evals`) |
| 6 | Local end-to-end (from phase 1) | `docker compose up -d`, `dev:web` + `dev:worker`, replay a captured hook body with a test JWT, and see the review in the logs or posted to the sandbox PR |
| 7 | Commit | Conventional message; one feature per commit |
| 8 | Live (from phase 6) | `fly deploy`, push a commit to the **sandbox repo PR**, and see a review from `ai-reviewer[bot]` for that SHA |
| 9 | Record | Tick the feature off in TodoWrite; when the phase is complete, mark it ✅ in PLAN.md §5 and note anything that diverged from the plan |

"Works locally" isn't done from phase 6 onwards. The live check is a real PR on the
sandbox repo getting the expected review.

## Suggested parallelism

| Phase | Plan |
|---|---|
| 0 Setup | `[seq]` everything (small) |
| 1 Skeleton | `[par]` Action yml + OIDC verify │ `[par]` queue + worker stub │ `[par]` GitHub App auth + stub review → `[gate]` end-to-end hello review |
| 2 Parser | `[seq]` freeze `ReviewContext` type in `src/schemas/` first; then `[par]` diff-map │ tree-sitter symbol lookup │ token budget/chunking |
| 3 Agents | `[seq]` `src/llm` client + `agents/base.ts`; then `[par]` one subagent per specialist agent → `[gate]` FlowProducer fan-out runs all 4 |
| 4 Judge | `[par]` judge prompt + merge │ renderer + publisher → `[gate]` full review on sandbox PR |
| 5 Evals | `[par]` fixture authoring (split by category) │ runner + metrics |
| 6 Deploy | `[seq]` (shared infra) |
| 7 Hardening | `[par]` supersede │ fork path │ rate limits │ cost guardrail │ README |
| 8 Proof | `[seq]`; v1.1 debate round only if the user opts in |

Phases 2 and 3 can overlap once the `ReviewContext` type is frozen.

## Subagent brief template

```
Feature: <name> (PLAN.md phase N, §<section>)
Exit criterion: <copied from PLAN.md>
Skills to load: acr-project, <acr-* for this part>
Files you own: <paths>. Do not edit outside them; shared types in src/schemas/ are frozen.
Pass ACR done-gate stations 2–7 from .claude/skills/acr-phase/SKILL.md.
Do not run `npm run eval` (the parent runs evals once per phase, after asking the user).
Report: files changed, test output, anything that diverged from PLAN.md.
```
