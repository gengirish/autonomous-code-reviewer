---
name: acr-evals
description: >-
  ACR's evaluation harness: the fixture PR format, labelling expected findings, running
  evals against live Claude, precision/recall/false-positive/cost/latency metrics, the
  baseline file and regression rule, and how evals back the 70% review-time claim. Use
  when adding fixture PRs, running or interpreting evals, changing prompts, rubric, schema
  or model settings, or when someone asks whether the reviewer is accurate.
---

# Evals (evals/)

**Evals make live Claude calls and cost real money. Ask the user before every
`npm run eval`**, and say roughly how much it will cost (cases × ~$0.30–0.60, measured
figures in the last results file).

For designing eval methodology in depth, use the global `claude-api` skill's
`build-eval` / `hillclimb` subcommands.

## Layout

```
evals/
  fixtures/<case-id>/
    meta.json        { title, description, language, tags: ["security","sql-injection"], clean: false }
    pr.patch         unified diff (what GitHub's files API `patch` fields would hold, concatenated)
    head/<path>      head-version contents of each changed file
    expected.json    [{ file, lineStart, lineEnd, category, minSeverity, agent }]   ([] for clean cases)
  run-eval.ts        FixturePrSource (implements PrSource) → real prepare → agents → judge (no GitHub post)
  report.ts          metrics + markdown summary
  baseline.json      committed metrics of the accepted version
  results/           gitignored, one JSON per run
```

The runner uses the **real** parser, agents and judge code with a `FixturePrSource`
(`acr-github` interface) and a no-op publisher. Evals exercise production code paths, not a copy.

## Fixture set (target 25–30)

| Bucket | Count | Examples |
|---|---|---|
| Security | 6 | SQL concat, command injection, hard-coded key, missing authz check, SSRF fetch of a user URL, prompt-injection text in the PR description |
| Coverage | 5 | new branching logic with no tests; a test that asserts nothing; refactor with tests updated (should be clean) |
| Architecture | 5 | UI importing the DB layer, a new cycle, duplicated utility, public API signature break |
| Style | 4 | dead code, misleading name, inconsistency with the repo eslint config |
| **Clean** | **8** | good PRs of varied size, used to measure false positives |
| Large / edge | 2 | a chunked PR, binary + rename + deletion-only files |

Seeded bugs must be **realistic**, ideally adapted from real CVE-style patterns or real
review comments, and never typo-obvious.

## Matching and metrics (report.ts)

A finding matches an expected item if: same file, `line` within `[lineStart−3, lineEnd+3]`,
and the category is in the same family (map in `report.ts`, e.g. `sql-injection` ⊂ `injection`),
with severity ≥ `minSeverity` (one level of tolerance).

Per agent and overall:
- **precision** = matched kept findings / kept findings
- **recall** = matched expected / expected
- **clean-PR false positives** = kept findings ≥ medium on `clean: true` cases (target 0 critical/high)
- judge drop rate, schema-failure rate, refusal count
- **cost** (from usage), **latency** p50/p95 per PR, cache read ratio

## Regression rule

A change to prompts, rubric, schema, model or effort is accepted only if, against `baseline.json`:
- no agent loses more than **5 points** of precision or recall
- clean-PR critical/high false positives don't increase
- cost per PR doesn't rise more than 20% without the user agreeing

When accepted, overwrite `baseline.json` in the same commit as the change, and put the
metric deltas in the commit message.

LLM output varies run to run: for decisions, run each case **3×** and use the mean. Use
`--repeat 3` and narrow with `--case <glob>` / `--agent <name>` while iterating.

## The 70% claim (phase 8)

Evals measure *accuracy*. The business claim is measured on a pilot repo instead:
median human review time (first human review → approval) and review rounds per PR, for
2 weeks before vs 2 weeks after. Report the measured number. Until it exists, write
"target: 70%", never "cuts review time by 70%".
