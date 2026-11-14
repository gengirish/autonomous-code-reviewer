---
name: acr-github
description: >-
  GitHub API layer for ACR: GitHub App installation auth, listing PR files, fetching
  head-version contents, posting the review (summary plus inline comments), the
  idempotency marker, check runs, and avoiding 422 errors on comment lines. Use when
  editing src/github/, debugging GitHub 4xx errors, changing what gets posted, or
  setting up the GitHub App.
---

# GitHub layer (src/github)

## GitHub App setup (once, sandbox first)

- Permissions: **Pull requests: read & write**, **Contents: read**, **Checks: read & write**,
  Metadata: read. No webhook subscription is needed, because the Action is the trigger.
- Install it on the sandbox repo only until phase 8.
- Private key: store it base64-encoded as `GITHUB_APP_PRIVATE_KEY_B64` (PEM newlines get
  mangled in `fly secrets`) and decode it in `src/env.ts`.

## Auth (src/github/app-auth.ts)

```ts
import { App } from "@octokit/app";
const app = new App({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY });

export async function octokitFor(owner: string, repo: string) {
  const { data } = await app.octokit.rest.apps.getRepoInstallation({ owner, repo });
  return app.getInstallationOctokit(data.id);   // token cached/refreshed by octokit
}
```

Cache the installation ID per repo in memory. No installation means fail the run with a
clear log line (`app not installed on owner/repo`) and don't retry.

## Reading a PR (src/github/pr-files.ts)

1. `pulls.get` gives the authoritative `head.sha`, `base.sha`, `draft` and `state`. Skip
   the run if the PR is closed or a draft, or if `head.sha` ≠ the job's SHA (superseded).
2. `octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number, per_page: 100 })`.
   - `patch` is **missing** for binary files and very large diffs. Treat those as "not reviewed" and list them in the summary.
   - The API caps the list (about 3000 files). Beyond that, review the first N and say so.
3. Head contents: use **`git.getBlob({ file_sha: file.sha })`** (base64, works for large files,
   no path or ref encoding issues) instead of `repos.getContent`.
4. Skip by path before fetching: lockfiles, `dist/`, `vendor/`, `*.min.*`, generated files,
   and anything in `.ai-reviewer.yml` `ignore:` (phase 7).

Behind an interface (`PrSource`) so evals and tests can provide fixture PRs:

```ts
interface PrSource {
  getPr(ref: PrRef): Promise<PrMeta>;
  listFiles(ref: PrRef): Promise<PrFile[]>;     // { path, status, patch?, blobSha }
  getContent(ref: PrRef, file: PrFile): Promise<string>;
}
```

## Posting the review (src/github/review.ts)

```ts
await octokit.rest.pulls.createReview({
  owner, repo, pull_number,
  commit_id: headSha,                       // pins comments to the reviewed SHA
  event,                                    // from acr-judge decideEvent(): "REQUEST_CHANGES" | "COMMENT"
  body,                                     // rendered markdown, contains the marker
  comments: inline.map(f => ({ path: f.file, line: f.line, side: "RIGHT", body: f.body })),
});
```

Rules:
- **Marker:** the body ends with `<!-- ai-reviewer run=<runId> sha=<headSha> -->`. Before
  posting, `paginate(pulls.listReviews)` and **skip if a review with this SHA's marker
  exists**. This is what makes retries safe.
- **Inline comments only on RIGHT-side lines inside a hunk.** `acr-parser` gives you the
  set of valid lines per file. Anything else goes into the body.
- **Cap at 15 inline comments**, ordered by severity. The rest go in a `<details>` block.
- Body limit is 65,536 chars. Truncate the details section first, never the verdict.
- **On 422** ("line must be part of the diff" and similar): retry **once** with
  `comments: []` and the inline findings folded into the body. Log which comment failed.
- 403 or 429 with `retry-after` / `x-ratelimit-reset`: throw so BullMQ backs off. Use one
  limiter per installation (`acr-queue`).

## Check run (optional, phase 7)

`checks.create({ name: "ai-reviewer", head_sha, status: "completed", conclusion, output: { title, summary } })`.
Conclusion: `action_required` for REQUEST_CHANGES, otherwise `neutral`. Never `failure`
on a model opinion unless the user enables blocking.

## Feedback signal (phase 8)

Store `githubCommentId` per inline finding. A scheduled job reads reactions
(`reactions.listForPullRequestReviewComment`) and saves 👍/👎 to `Feedback`. Poll at
most daily so Redis/Postgres can still idle (see `idle-cost-audit`).
