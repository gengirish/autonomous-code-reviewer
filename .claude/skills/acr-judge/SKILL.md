---
name: acr-judge
description: >-
  The ACR judge and review output: merging and de-duplicating the four agents' findings,
  checking them against the code, final severity from the rubric, the deterministic
  verdict rule (REQUEST_CHANGES vs COMMENT), and rendering the review markdown with the
  per-agent breakdown. Use when editing src/judge/ or src/render/, changing severity or
  verdict logic, or changing how the posted review looks.
---

# Judge, verdict and rendering (src/judge, src/render)

## Judge call (src/judge/judge.ts)

Input:
- all `AgentReport`s (from `job.getChildrenValues()`, and all chunks if the PR was chunked)
- for each finding, the code around `file:line` (±15 lines from head content) plus its
  `unverified` tag from `acr-agents`
- `rubric.md`
- which agents failed or were skipped

Output (Zod, structured):

```ts
JudgedFinding = Finding & {
  sourceAgents: AgentName[];        // merged duplicates keep every source
  kept: boolean; dropReason?: "duplicate" | "not-supported-by-code" | "out-of-scope" | "low-value";
  finalSeverity: Severity;
}
JudgeOutput = { findings: JudgedFinding[]; summary: string /* ≤ 120 words, no verdict wording */ }
```

Judge instructions (in `src/judge/prompt.md`):
1. **Merge** findings about the same root cause, even when they come from different agents or
   lines. Keep the clearest rationale and union `sourceAgents`.
2. **Verify** each finding against the code shown. If the code doesn't support it, set
   `kept: false` with reason `not-supported-by-code`. This is the main hallucination filter.
3. Set **finalSeverity** using `rubric.md`. It may differ from the agent's severity; it's the
   rubric that counts.
4. Don't invent new findings. The judge filters and calibrates, it doesn't review.

Model `claude-opus-5-5`, `effort: JUDGE_EFFORT` ("high"). Separate request, no cache
sharing with the agents.

## rubric.md (summary, the file holds the full version)

| Severity | Meaning |
|---|---|
| critical | Exploitable security hole, data loss or corruption, or a crash on the main path. Must fix before merge |
| high | Likely bug or security weakness on a reachable path; missing tests for risky new logic; contract break |
| medium | Real but bounded issue: an edge-case bug, maintainability debt that will bite |
| low | Minor improvement |
| nit | Taste/consistency. Never inline unless the repo config enables nits |

## Verdict (src/judge/verdict.ts): code decides, not the model

```ts
export function decideEvent(fs: JudgedFinding[], cfg: RepoConfig): "REQUEST_CHANGES" | "COMMENT" | "APPROVE" {
  const kept = fs.filter(f => f.kept);
  if (kept.some(f => f.finalSeverity === "critical" || f.finalSeverity === "high")) return "REQUEST_CHANGES";
  if (cfg.allowApprove && kept.every(f => f.finalSeverity === "nit" || f.finalSeverity === "low")) return "APPROVE";
  return "COMMENT";
}
```

`allowApprove` defaults to **false** (PLAN.md §8). Unit-test every branch.

## Rendering (src/render/review-markdown.ts)

Deterministic and pure (`(judged, reports, meta) → { body, inline[] }`), and snapshot-tested.

```markdown
## 🤖 AI Review: Changes requested
**2 high · 3 medium · 1 low** across 7 files · reviewed `abc1234`

> <judge summary>

| Agent | Raised | Kept | Top issue |
|---|---|---|---|
| 🔒 Security | 3 | 2 | SQL built from request params (`src/db/users.ts:42`) |
| 🎨 Style | 5 | 1 | … |
| 🧪 Coverage | 2 | 2 | … |
| 🏛️ Architecture | 1 | 0 | n/a |

<details><summary>More findings (4)</summary> … non-inline + over-cap findings … </details>
<details><summary>Not reviewed (2)</summary> binary/oversized/skipped files, failed agents </details>

<sub>Autonomous Code Reviewer · findings are suggestions; humans decide.</sub>
<!-- ai-reviewer run=<runId> sha=<headSha> -->
```

Inline comment body, in this order:
1. Header line: `**[high · security · sql-injection]** <title>`
2. Rationale paragraph
3. Optional GitHub `suggestion` fenced block. Use it **only** when `suggestion` is a literal
   replacement for exactly the commented line range (`line`..`endLine`). Otherwise put the
   suggestion in plain prose.

Inline selection: only `kept` findings with `line ∈ commentableLines`, severity ≥ `low`
(nits only if enabled), sorted by severity then confidence, **max 15**.
