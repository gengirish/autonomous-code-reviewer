---
name: acr-trigger
description: >-
  The ACR entry point: the GitHub Actions workflow installed in target repos
  (action/ai-review.yml), GitHub OIDC token verification, and the Fastify POST
  /hooks/pr route that validates and enqueues a review. Use when editing action/,
  src/server/, OIDC/JWT auth, fork-PR handling, or anything about how a PR event
  reaches the queue.
---

# Trigger: Action → /hooks/pr → queue

Generic hardening checklist: `harden-webhook-endpoint`. Here is how ACR meets each item:

| Control | ACR implementation |
|---|---|
| Verify signature before parsing | GitHub OIDC JWT verified against GitHub's JWKS (no shared secret) |
| Idempotency | BullMQ jobId derived from `(owner, repo, pr, headSha)`; see `acr-queue` |
| Replay protection | JWT `exp` (tokens are short-lived) + `aud` must equal `OIDC_AUDIENCE` |
| Retry / dead-letter | BullMQ attempts + failed set; the Action itself does not retry |
| Audit | Log `{runId, repository, pr, headSha}` only, never the token |

## action/ai-review.yml (copied into each target repo)

```yaml
name: ai-review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
  id-token: write
concurrency:
  group: ai-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  request-review:
    if: github.event.pull_request.draft == false && github.event.pull_request.head.repo.fork == false   # forks use ai-review-fork.yml
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/github-script@v7
        env:
          REVIEWER_URL: ${{ vars.AI_REVIEWER_URL }}
        with:
          script: |
            const token = await core.getIDToken('ai-reviewer');
            const pr = context.payload.pull_request;
            const res = await fetch(`${process.env.REVIEWER_URL}/hooks/pr`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
              body: JSON.stringify({
                owner: context.repo.owner, repo: context.repo.repo,
                pr: pr.number, baseSha: pr.base.sha, headSha: pr.head.sha,
              }),
            });
            if (res.status !== 202) core.setFailed(`reviewer ${res.status}: ${await res.text()}`);
```

- The target repo sets the `AI_REVIEWER_URL` repository variable (not a secret).
- Optional coverage step (phase 7+): run tests with lcov and send a **compressed summary
  for changed files only**. Size-cap it server-side.
- **Fork PRs:** `pull_request` from a fork doesn't get `id-token: write`. Add a second
  workflow on `pull_request_target` for forks. That's safe **only because the job never
  runs `actions/checkout` on the PR head and never executes PR code.** Keep it that way,
  and say why in a comment in the yml.

## OIDC verification (src/server/auth/oidc.ts)

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../../env.js";

const ISSUER = "https://token.actions.githubusercontent.com";
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));

export async function verifyActionsToken(token: string) {
  const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER, audience: env.OIDC_AUDIENCE });
  const repository = String(payload.repository);          // "owner/repo"
  const owner = String(payload.repository_owner);
  if (!env.ALLOWED_OWNERS.includes(owner)) throw new ForbiddenError("owner not allowed");
  return { repository, owner, eventName: String(payload.event_name) };
}
```

Rules:
- The body's `owner/repo` **must equal** the JWT `repository` claim, or the request gets a 403.
- `event_name` must be `pull_request` or `pull_request_target`.
- **Don't trust body SHAs for the review itself.** The worker re-reads the PR with the
  installation token and uses the API's `head.sha`. The body SHA is only used for the job ID.

## Route (src/server/routes/hook.ts)

1. Read `authorization: Bearer <jwt>` and verify it (401 on failure, 403 on an owner mismatch).
2. `HookBody.parse(body)` (Zod: `owner`, `repo`, `pr` positive int, `baseSha`/`headSha` 40-hex).
3. Enqueue the `prepare` job (`acr-queue`). If the job already exists, still return 202
   with the same `runId`.
4. Reply `202 { runId }` within about 200 ms. No GitHub or Claude calls in this process.

Also `GET /healthz` (no dependencies; Fly health check) and Bull Board at `/admin/queues`
behind basic auth (`@bull-board/api` + `@bull-board/fastify`).

## Tests

Use `fastify.inject()`. Sign test JWTs with a local key pair from `jose.generateKeyPair`,
and make the JWKS source injectable (constructor parameter) so tests don't hit GitHub.
Cover: valid → 202; wrong aud → 401; owner not allowed → 403; body repo ≠ claim → 403;
duplicate → 202 with the same runId.
