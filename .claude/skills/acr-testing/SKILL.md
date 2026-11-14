---
name: acr-testing
description: >-
  How to test ACR with Vitest: unit tests for diff mapping, parsing, verdict and
  rendering; integration tests for the hook route and BullMQ flows with real Redis;
  fakes for GitHub (PrSource/publisher) and Claude (FakeLlm with recorded reports); and
  what never to call live in tests. Use when writing or fixing tests, adding a test
  fixture, or setting up CI test jobs.
---

# Testing (test/)

Debugging failures: `systematic-debugging`. CI workflow: `setting-up-ci`.

## Rule zero

`npm test` makes **no network calls**: no Anthropic, no GitHub, no Redis. Live Claude only
runs in `npm run eval` (`acr-evals`); live GitHub only on the sandbox repo (`acr-deploy`).
Guard it in `test/setup.ts`: unset `ANTHROPIC_API_KEY` and fail any `fetch` to a non-localhost host.

## Layout

```
test/
  unit/
    diff-map.test.ts          real patches: multi-hunk, rename, deletion-only, "\ No newline"
    treesitter.test.ts        enclosing-symbol lookup per language fixture
    context-builder.test.ts   deterministic rendering (same input → byte-identical output)
    finding-validate.test.ts  drops unknown files, demotes non-commentable lines, evidence check
    verdict.test.ts           every decideEvent branch
    render.test.ts            snapshot of the review markdown; 65,536-char cap; inline cap 15
    oidc.test.ts              local JWKS: good / wrong aud / wrong owner / expired
  integration/
    hook.test.ts              fastify.inject → job enqueued; duplicate → same runId
    flow.test.ts              real Redis: 4 agents → judge → publish; one agent fails → judge still runs
    supersede.test.ts         new SHA → old run does no LLM or GitHub calls
  fakes/
    fake-llm.ts               LlmClient returning recorded AgentReport/JudgeOutput by (agent, fixture)
    fake-pr-source.ts         PrSource over evals/fixtures/<case>
    fake-publisher.ts         records createReview payloads
  fixtures/patches/*.patch
```

## Vitest config

Two projects: `unit` (default, `npm test`) and `integration` (`npm run test:integration`,
`docker compose up -d redis` first, a unique BullMQ `prefix` per file, `fileParallelism: false`).

## Fakes, not mocks of internals

The code has four seams, all interfaces: `LlmClient`, `PrSource`, `Publisher`, and the JWKS
source. Tests swap implementations at these seams. Don't `vi.mock` our own modules. If a test
needs to, the seam is missing, so add it.

`FakeLlm` records each request (system, messages, output_config). Use it to assert **cache
discipline**: all four agent requests share a byte-identical prefix up to and including the
context block, and differ only in the trailing role message.

## Recording LLM fixtures

`npm run eval -- --record test/fixtures/llm/` (asks first, live) writes real reports that
`FakeLlm` replays. Re-record when the schema changes. Commit the recordings.

## What every PR to this repo must keep green

`npm run typecheck && npm run lint && npm test`, plus `npm run test:integration` for changes
under `src/queue`, `src/worker` or `src/server`.
