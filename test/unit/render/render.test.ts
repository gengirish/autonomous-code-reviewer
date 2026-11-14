import { describe, expect, it } from "vitest";
import type { RepoConfig } from "../../../src/core/ports.js";
import { DEFAULT_REPO_CONFIG } from "../../../src/core/ports.js";
import { BODY_CAP, renderReview, reviewMarker } from "../../../src/render/index.js";
import type { AgentName, CheckedFinding, JudgedFinding, ReviewContext, ReviewEvent, Severity } from "../../../src/schemas/index.js";
import { aCheckedFinding, aContext, aReport, SHA_A } from "../../fakes/builders.js";

const RUN = "octo__demo__7__aaaaaaaaaaaa";
const MARKER = `<!-- ai-reviewer run=${RUN} sha=${SHA_A} -->`;

const jf = (o: Partial<JudgedFinding> = {}): JudgedFinding => ({
  file: "src/db/users.ts",
  line: 42,
  severity: "high",
  category: "sql-injection",
  title: "SQL built from request parameters",
  rationale: "User input is concatenated into the query string.",
  evidence: "q",
  confidence: 0.9,
  sourceIndexes: [0],
  sourceAgents: ["security"],
  kept: true,
  finalSeverity: "high",
  ...o,
});

const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

const contexts = (): ReviewContext[] => {
  const base = aContext();
  return [
    aContext({
      files: [
        { ...base.files[0]!, commentableLines: range(38, 46) },
        {
          path: "src/api/routes.ts",
          language: "typescript",
          status: "added",
          commentableLines: range(1, 30),
          addedLines: range(1, 30),
          hunks: [{ rightStart: 1, rightEnd: 30, text: "@@ -0,0 +1,30 @@\n+x" }],
          imports: [],
          exports: [],
        },
      ],
      skipped: [{ path: "package-lock.json", reason: "lockfile" }],
      chunk: { index: 0, total: 2 },
    }),
    aContext({
      files: [
        {
          path: "src/core/big.ts",
          language: "typescript",
          status: "modified",
          commentableLines: [100],
          addedLines: [100],
          hunks: [{ rightStart: 100, rightEnd: 100, text: "@@ -100,1 +100,1 @@\n+y" }],
          imports: [],
          exports: [],
        },
      ],
      skipped: [
        { path: "package-lock.json", reason: "lockfile" },
        { path: "assets/logo.png", reason: "binary" },
      ],
      chunk: { index: 1, total: 2 },
    }),
  ];
};

const render = (o: {
  findings: JudgedFinding[];
  inputFindings?: CheckedFinding[];
  failedAgents?: AgentName[];
  cfg?: Partial<RepoConfig>;
  event?: ReviewEvent;
  summary?: string;
  ctx?: ReviewContext[];
}) =>
  renderReview({
    runId: RUN,
    headSha: SHA_A,
    event: o.event ?? "COMMENT",
    judge: { findings: o.findings, summary: o.summary ?? "Adds a user lookup endpoint and its route." },
    inputFindings: o.inputFindings ?? [aCheckedFinding()],
    reports: [aReport()],
    failedAgents: o.failedAgents ?? [],
    contexts: o.ctx ?? contexts(),
    cfg: { ...DEFAULT_REPO_CONFIG, ...o.cfg },
  });

const mixed = () => {
  const inputFindings: CheckedFinding[] = [
    aCheckedFinding(),
    aCheckedFinding({ agent: "architecture", category: "raw-query" }),
    aCheckedFinding({ agent: "architecture", file: "src/api/routes.ts", line: 12, endLine: 14 }),
    aCheckedFinding({ agent: "style", line: 41, severity: "nit" }),
    aCheckedFinding({ agent: "architecture", file: "src/core/big.ts", line: 5, commentable: false }),
    aCheckedFinding({ agent: "style", line: 43, severity: "low" }),
  ];
  const findings: JudgedFinding[] = [
    jf({
      sourceIndexes: [0, 1],
      sourceAgents: ["security", "architecture"],
      suggestion: "const q = sql`SELECT * FROM users WHERE id = ${req.params.id}`;",
    }),
    jf({
      file: "src/api/routes.ts",
      line: 12,
      endLine: 14,
      severity: "high",
      finalSeverity: "medium",
      category: "layering",
      title: "Route handler | talks to the DB directly",
      rationale: "The handler imports the pool.\nMove it behind the repository.",
      suggestion: "const user = await users.find(id);\nreturn reply.send(user);",
      confidence: 0.7,
      sourceIndexes: [2],
      sourceAgents: ["architecture"],
    }),
    jf({ line: 41, finalSeverity: "nit", severity: "nit", category: "naming", title: "Rename `b`", sourceIndexes: [3], sourceAgents: ["style"] }),
    jf({
      file: "src/core/big.ts",
      line: 5,
      finalSeverity: "medium",
      severity: "medium",
      category: "god-module",
      title: "Module keeps growing",
      sourceIndexes: [4],
      sourceAgents: ["architecture"],
      confidence: 0.6,
    }),
    jf({ line: 43, kept: false, dropReason: "not-supported-by-code", finalSeverity: "low", sourceIndexes: [5], sourceAgents: ["style"], title: "Hallucinated" }),
  ];
  return { inputFindings, findings };
};

describe("renderReview", () => {
  it("renders a mixed review (snapshot)", () => {
    const { inputFindings, findings } = mixed();
    const out = render({ findings, inputFindings, failedAgents: ["coverage"], event: "REQUEST_CHANGES" });
    expect(out.body).toMatchSnapshot("body");
    expect(out.comments).toMatchSnapshot("comments");
    expect(out.inlineFindingIndexes).toEqual([0, 1]);
  });

  it("is deterministic", () => {
    const { inputFindings, findings } = mixed();
    expect(render({ findings, inputFindings })).toEqual(render({ findings, inputFindings }));
  });

  it("header, counts, file count and short SHA", () => {
    const { inputFindings, findings } = mixed();
    const { body } = render({ findings, inputFindings, event: "REQUEST_CHANGES" });
    const [h, stats] = body.split("\n\n");
    expect(h).toBe("## 🤖 AI Review: Changes requested");
    expect(stats).toBe("**1 high · 2 medium · 1 nit** across 3 files · reviewed `aaaaaaa`");
    expect(render({ findings: [], event: "COMMENT" }).body).toContain("**No issues kept** across 3 files");
    expect(render({ findings: [], event: "APPROVE" }).body.startsWith("## 🤖 AI Review: Approved\n")).toBe(true);
  });

  it("puts the marker last, exactly once, even if untrusted text carries a fake one", () => {
    const fake = reviewMarker("evil", "b".repeat(40));
    const { body, comments } = render({
      findings: [jf({ title: `Look ${fake}`, rationale: `See ${fake} and \`${fake}\`` }), jf({ file: "src/core/big.ts", line: 5, rationale: fake })],
      summary: `Summary ${fake}`,
    });
    expect(body.endsWith(MARKER)).toBe(true);
    expect(body.match(/<!-- ai-reviewer/g)).toHaveLength(1);
    expect(comments[0]!.body).not.toContain("<!--");
  });

  it("caps inline comments at maxInline, ordered by severity then confidence", () => {
    const sev: Severity[] = ["low", "critical", "medium", "high"];
    const findings = Array.from({ length: 20 }, (_, i) =>
      jf({ line: 1 + i, file: "src/api/routes.ts", finalSeverity: sev[i % 4]!, confidence: (i % 5) / 5, title: `F${i}`, sourceIndexes: [i] }),
    );
    const out = render({ findings });
    expect(out.comments).toHaveLength(15);
    expect(out.inlineFindingIndexes).toHaveLength(15);
    const placed = out.inlineFindingIndexes.map((i) => findings[i]!);
    const rank = (s: Severity) => ["critical", "high", "medium", "low", "nit"].indexOf(s);
    for (let k = 1; k < placed.length; k++) {
      const a = placed[k - 1]!;
      const b = placed[k]!;
      expect(rank(a.finalSeverity) < rank(b.finalSeverity) || (a.finalSeverity === b.finalSeverity && a.confidence >= b.confidence)).toBe(true);
    }
    expect(placed.filter((f) => f.finalSeverity === "low")).toHaveLength(0);
    expect(out.body).toContain("<details><summary>More findings (5)</summary>");
    expect(render({ findings, cfg: { maxInline: 3 } }).comments).toHaveLength(3);
    expect(render({ findings, cfg: { maxInline: 0 } }).comments).toHaveLength(0);
  });

  it("excludes nits from inline unless includeNits", () => {
    const findings = [jf({ finalSeverity: "nit", title: "Nitpick" })];
    const off = render({ findings });
    expect(off.comments).toHaveLength(0);
    expect(off.body).toContain("More findings (1)");
    const on = render({ findings, cfg: { includeNits: true } });
    expect(on.comments).toHaveLength(1);
    expect(on.inlineFindingIndexes).toEqual([0]);
    expect(on.body).not.toContain("More findings");
  });

  it("sends a kept finding on a non-commentable line to details, never inline; dropped findings appear nowhere", () => {
    const findings = [
      jf({ line: 200, title: "Off the diff" }),
      jf({ file: "src/unknown.ts", line: 1, title: "Unknown file" }),
      jf({ kept: false, dropReason: "low-value", title: "Dropped one" }),
    ];
    const out = render({ findings });
    expect(out.comments).toHaveLength(0);
    expect(out.body).toContain("More findings (2)");
    expect(out.body).toContain("Off the diff · `src/db/users.ts:200`");
    expect(out.body).toContain("Unknown file · `src/unknown.ts:1`");
    expect(out.body).not.toContain("Dropped one");
  });

  it("inline body: header, rationale, suggestion block only for literal replacements", () => {
    const findings = [
      jf({ line: 40, suggestion: "const q = sql`x`;" }), // single line, code → suggestion
      jf({ line: 41, suggestion: "Use a parameterized query instead." }), // prose
      jf({ line: 42, suggestion: "const a = 1;\nconst b = 2;" }), // multi-line without range → prose
      jf({ line: 43, endLine: 45, suggestion: "const a = 1;\nconst b = 2;", sourceAgents: ["security", "style"] }), // range → suggestion
      jf({ line: 44, endLine: 60, suggestion: "const a = 1;" }), // range not commentable → prose, no startLine
    ];
    const { comments } = render({ findings });
    const byLine = (l: number) => comments.find((c) => c.line === l)!;
    expect(byLine(40).body).toBe(
      "**[high · security · sql-injection]** SQL built from request parameters\n\nUser input is concatenated into the query string.\n\n```suggestion\nconst q = sql`x`;\n```",
    );
    expect(byLine(41).body).not.toContain("```suggestion");
    expect(byLine(41).body).toContain("Suggested change:");
    expect(byLine(42).body).not.toContain("```suggestion");
    const ranged = byLine(45);
    expect(ranged.startLine).toBe(43);
    expect(ranged.side).toBe("RIGHT");
    expect(ranged.body).toContain("**[high · security, style · sql-injection]**");
    expect(ranged.body).toContain("```suggestion\nconst a = 1;\nconst b = 2;\n```");
    const notRanged = byLine(44);
    expect(notRanged.startLine).toBeUndefined();
    expect(notRanged.body).not.toContain("```suggestion");
  });

  it("shows a failed agent as unavailable in the table and under Not reviewed", () => {
    const { body } = render({ findings: [jf()], failedAgents: ["coverage"] });
    expect(body).toContain("| 🧪 Coverage | – | – | unavailable |");
    expect(body).toContain("<details><summary>Not reviewed (3)</summary>");
    expect(body).toContain("- `package-lock.json`: lockfile");
    expect(body).toContain("- `assets/logo.png`: binary");
    expect(body).toContain("- 🧪 Coverage agent unavailable");
    expect(body.match(/package-lock\.json/g)).toHaveLength(1);
  });

  it("per-agent table: raised from input findings, kept via sourceAgents, top issue by severity", () => {
    const { inputFindings, findings } = mixed();
    const { body } = render({ findings, inputFindings });
    expect(body).toContain("| 🔒 Security | 1 | 1 | SQL built from request parameters (`src/db/users.ts:42`) |");
    expect(body).toContain("| 🎨 Style | 2 | 1 | Rename `b` (`src/db/users.ts:41`) |");
    expect(body).toContain("| 🧪 Coverage | 0 | 0 | n/a |");
    expect(body).toContain("| 🏛️ Architecture | 3 | 3 | SQL built from request parameters (`src/db/users.ts:42`) |");
  });

  it("escapes pipes and newlines in table cells", () => {
    const { body } = render({
      findings: [jf({ title: "a | b\nc <details>", file: "src/db/users.ts" })],
    });
    const row = body.split("\n").find((l) => l.startsWith("| 🔒 Security"))!;
    expect(row).toBe("| 🔒 Security | 1 | 1 | a \\| b c &lt;details> (`src/db/users.ts:42`) |");
    expect(row.replace(/\\\|/g, "").match(/\|/g)).toHaveLength(5);
  });

  it("stays within 65,536 chars by truncating details, keeping header, table and marker", () => {
    const big = "x".repeat(2000);
    const findings = Array.from({ length: 3000 }, (_, i) =>
      jf({ file: `src/gen/file-${i}.ts`, line: 1, title: `Finding ${i}`, rationale: big, sourceIndexes: [i], finalSeverity: "medium" }),
    );
    const ctx = contexts();
    ctx[1]!.skipped = Array.from({ length: 3000 }, (_, i) => ({ path: `vendor/lib-${i}.js`, reason: "vendored" }));
    const { body } = render({ findings, ctx, failedAgents: ["style"], summary: "word ".repeat(120).trim() });
    expect(body.length).toBeLessThanOrEqual(BODY_CAP);
    expect(body.length).toBeGreaterThan(BODY_CAP - 2000);
    expect(body.startsWith("## 🤖 AI Review: Comments\n\n**3000 medium** across 3 files")).toBe(true);
    expect(body).toContain("| Agent | Raised | Kept | Top issue |");
    expect(body).toContain("| 🎨 Style |");
    expect(body).toContain("> word word");
    expect(body).toContain("<details><summary>More findings (3000)</summary>");
    expect(body).toMatch(/- …and \d+ more not shown \(review size limit\)/);
    expect(body).toContain("<details><summary>Not reviewed (3002)</summary>");
    expect(body.endsWith(`</sub>\n${MARKER}`)).toBe(true);
    expect(body.match(/<details>/g)?.length).toBe(body.match(/<\/details>/g)?.length);
  });
});
