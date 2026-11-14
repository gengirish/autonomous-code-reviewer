# Evals

Fixture PRs with labelled expected findings, run through the real parser → 4 agents →
judge code, scored for precision, recall, clean-PR false positives, cost and latency.

> **Cost warning.** `npm run eval` makes **live Claude calls and bills real money**
> (roughly $0.30–0.60 per case per run; 16 cases × `--repeat 3` is about $15–30).
> **Ask the user before every run** and quote the estimate. `npm test` never calls Claude:
> it only validates the fixtures and tests the harness with stubs.

## Files

| Path | What |
|---|---|
| `fixtures/<case-id>/` | one fixture PR (format below) |
| `schema.ts` | Zod schemas for `meta.json` and `expected.json` |
| `fixture-source.ts` | `loadFixture`, `loadAllFixtures`, `FixturePrSource` (a `PrSource` over a fixture) |
| `harness.ts` | `runCase` / `runCaseOnce`: prepare → agents in parallel → judge, no queues, no GitHub |
| `metrics.ts` | matching rule, `CATEGORY_FAMILIES`, per-agent and overall metrics, `CaseRunRecord` |
| `report.ts` | `buildReport` (metrics + markdown), `compareToBaseline` (regression rule) |
| `baseline.json` | metrics of the accepted version (`{ "status": "no-baseline-yet" }` until the first accepted run) |
| `run-eval.ts` | CLI that wires the real pipeline (`--case`, `--agent`, `--repeat`, `--record`) |
| `results/` | gitignored, one JSON per run |

## Fixture format

```
fixtures/<case-id>/          kebab-case; prefix with the bucket: sec-, cov-, arch-, style-, clean-
  meta.json                  { title, description, language, tags, clean, notes? }
  pr.patch                   multi-file unified diff, exactly as `git diff` prints it
  head/<path>                head version of every changed file (not for deleted files),
                             plus unchanged repo files served by getRepoFile (lint configs)
  expected.json              [] for clean cases, otherwise:
```

```jsonc
[
  // tied to code: RIGHT-side (head) line numbers
  { "file": "src/routes/orders.ts", "lineStart": 24, "lineEnd": 28,
    "category": "sql-injection", "minSeverity": "high", "agent": "security",
    "note": "why this is a problem (shown in reports, never sent to the model)" },
  // not tied to code (e.g. prompt injection in the PR description)
  { "scope": "pr", "category": "prompt-injection-attempt", "minSeverity": "high", "agent": "security" }
]
```

- `title` and `description` are what the agents see as the PR title and body.
  `notes` is for fixture authors only and is never sent to the model.
- `clean: true` means a good PR: every kept finding ≥ medium on it is a false positive.
  Clean cases have `expected: []`, seeded cases have at least one expected item.
- `language`: `typescript`, `javascript`, `python`, `go` or `mixed`.

### Matching rule

A kept judged finding matches an expected item when it is in the same file, its `line`
is within `[lineStart − 3, lineEnd + 3]`, its category equals the expected one or is in
the same family (`CATEGORY_FAMILIES` in `metrics.ts`), and its `finalSeverity` is at
least `minSeverity` with one level of tolerance (`high` also accepts `medium`). Matching
is one-to-one: a duplicate finding can't claim a second expected item, so it counts as a
false positive. If agents start using a new spelling for a known issue, add it to the
family rather than to `expected.json`.

### TypeScript header line

The root `tsc` includes `evals/**`, and fixture code imports packages this repo doesn't
have. So every `.ts`/`.tsx` file under `head/` starts with this line, which
`fixture-source.ts` strips before anything reads the file:

```
// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
```

All line numbers (`pr.patch`, `expected.json`) refer to the file **without** that line.
ESLint is kept out of fixtures by `fixtures/eslint.config.js`, and `fixtures/.gitattributes`
stops line-ending conversion. Use LF only. Don't name a fixture repo config
`eslint.config.*` (ESLint would load it): use `.eslintrc.json`.

## Adding a case

1. Write the base and head versions of each file in a scratch directory. Make the seeded
   issue **realistic** (adapted from a real bug or review comment, never typo-obvious) and
   keep the rest of the PR good: add tests and a believable description, so unrelated
   findings don't muddy precision.
2. Generate the patch with git rather than by hand, so it is a valid diff:

   ```bash
   cd "$(mktemp -d)" && git init -q && git config core.autocrlf false
   cp -r /path/to/base/. . && git add -A && git commit -qm base
   git rm -rq . && cp -r /path/to/head/. . && git add -A
   git diff --cached -M > /path/to/evals/fixtures/<case-id>/pr.patch
   ```

3. Copy the head files into `fixtures/<case-id>/head/` (adding the TypeScript header line
   to `.ts`/`.tsx` files) and write `meta.json` and `expected.json`. Find line numbers with
   `grep -n` on your scratch head files (no header line there).
4. `npm test`. `test/unit/evals/fixtures.test.ts` checks the schemas, that every `+` and
   context line of the patch equals the head file at that RIGHT line, that expected
   findings sit on commentable lines of changed files, and the bucket counts (update the
   counts there when you add a case).
5. Ask the user, then run the new case live: `npm run eval -- --case <case-id>`.

## Running (live, costs money)

```bash
npm run eval -- --case 'sec-*' --agent security --repeat 3   # narrow while iterating
npm run eval -- --repeat 3                                   # full run for a decision
npm run eval -- --case <id> --record test/fixtures/llm/      # record reports for FakeLlm
```

For a decision run every case 3× and use the mean. The regression rule against
`baseline.json`: no agent loses more than 5 points of precision or recall, clean-PR
critical/high false positives (per clean run) don't increase, and cost per PR doesn't
rise more than 20% without the user's agreement. When accepted, overwrite
`baseline.json` (`toBaseline(metrics)` from `report.ts`) in the same commit as the change,
with the metric deltas in the commit message.

## Fixture set

| Case | Seeded issue |
|---|---|
| `sec-sql-concat-express` (TS) | Express `GET /orders` interpolates `req.query.status` into SQL; sort is allow-listed and the id is parameterised, which makes it look careful |
| `sec-command-injection-exec` (JS) | `child_process.exec` template literal with the multer `originalname`-derived file name; only the width is validated |
| `sec-hardcoded-api-key` (Py) | live API key as the `os.environ.get` default in `config.py` |
| `sec-prompt-injection-description` (Go) | clean `Retry-After` change; the PR description tells the AI reviewer to ignore its instructions and approve |
| `cov-discount-branches-untested` (TS) | new loyalty discount with five branches and no tests |
| `cov-test-asserts-nothing` (Py) | new tests that assert only `is not None`/`isinstance`, or nothing at all |
| `cov-refactor-tests-updated` (Py) | **clean**: if/elif → rule table refactor with tests updated |
| `arch-ui-imports-db-layer` (TSX) | `"use client"` React component imports the Prisma repository directly |
| `arch-import-cycle` (Py) | `billing.invoices` ↔ `notifications.mailer` cycle hidden behind a function-local import |
| `arch-signature-break-callers` (JS) | `retry(fn, attempts, delay)` → options object; an old-style caller now silently uses defaults |
| `style-dead-code-misleading-name` (Go) | `filterOlderThan` keeps the newer events; `dedupeByActor` is never called |
| `style-eslint-config-inconsistency` (TS) | new job breaks the repo's `.eslintrc.json`: banned `moment`, default export, `console.log` |
| `clean-ts-cursor-pagination` (TS) | **clean**, small: opaque keyset cursors with validation and tests |
| `clean-py-csv-contact-import` (Py) | **clean**, medium: CSV row validation collecting every error, with tests |
| `clean-go-graceful-shutdown` (Go) | **clean**: `signal.NotifyContext` + `Server.Shutdown` with tests |
| `clean-ts-rename-date-utils` (TS) | **clean**, multi-file: rename (×2), deleted file, importer updates, new helper with tests |
