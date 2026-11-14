# Installing the AI reviewer in a repository

The reviewer is triggered by a small GitHub Actions workflow. It sends no code: it
requests a GitHub OIDC token (audience `ai-reviewer`) and POSTs the PR number and
SHAs to the reviewer, which then reads the PR through the GitHub API.

## Prerequisites

- The ACR GitHub App is installed on the repository (it reads the PR and posts the review).
- The repository owner (user or org) is listed in the reviewer's `ALLOWED_OWNERS`.
  Requests from other owners are rejected with 403.

## Steps

1. Copy `ai-review.yml` into the target repository as `.github/workflows/ai-review.yml`.
2. Optional, for pull requests from forks: also copy `ai-review-fork.yml` to
   `.github/workflows/ai-review-fork.yml`. Read the comment at the top of that file first.
   It is safe only because it never checks out or runs PR code. Don't add steps to it.
3. Set the repository variable (a variable, not a secret) `AI_REVIEWER_URL` to the
   reviewer's base URL with no trailing slash, e.g. `https://acr.fly.dev`:
   - UI: Settings → Secrets and variables → Actions → Variables → New repository variable
   - CLI: `gh variable set AI_REVIEWER_URL --body https://acr.fly.dev --repo OWNER/REPO`
   An organization-level variable works too.
4. Open or update a non-draft pull request. The `ai-review` check should pass in a few
   seconds (the reviewer answers `202 { runId }` and does the work asynchronously); the
   review appears on the PR a few minutes later.

## Troubleshooting

| Check output | Meaning |
|---|---|
| `reviewer 401` | Token rejected: wrong audience, expired, or not a GitHub Actions token. Make sure `id-token: write` is in `permissions`. |
| `reviewer 403` | The owner isn't in `ALLOWED_OWNERS`, the event isn't a PR event, or the body's repo doesn't match the token. |
| `reviewer 400` | Malformed request body. The workflow file was probably edited. |
| `Unable to get ACTIONS_ID_TOKEN_REQUEST_URL` | A fork PR ran under `pull_request`, which gets no OIDC token. Install `ai-review-fork.yml`. |
