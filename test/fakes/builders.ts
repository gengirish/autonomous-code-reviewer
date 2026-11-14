/** Small builders for valid test objects. Override any field. */
import type { AgentReport, CheckedFinding, Finding, ReviewContext } from "../../src/schemas/index.js";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);

export const aFinding = (o: Partial<Finding> = {}): Finding => ({
  file: "src/db/users.ts",
  line: 42,
  severity: "high",
  category: "sql-injection",
  title: "SQL built from request parameters",
  rationale: "User input is concatenated into the query string.",
  evidence: "`SELECT * FROM users WHERE id = ${req.params.id}`",
  confidence: 0.9,
  ...o,
});

export const aCheckedFinding = (o: Partial<CheckedFinding> = {}): CheckedFinding => ({
  ...aFinding(),
  agent: "security",
  commentable: true,
  unverified: false,
  ...o,
});

export const aReport = (o: Partial<AgentReport> = {}): AgentReport => ({
  agent: "security",
  summary: "One injection risk.",
  findings: [aFinding()],
  ...o,
});

export const aContext = (o: Partial<ReviewContext> = {}): ReviewContext => ({
  runId: "octo__demo__7__aaaaaaaaaaaa",
  owner: "octo",
  repo: "demo",
  pr: 7,
  headSha: SHA_A,
  baseSha: SHA_B,
  title: "Add user lookup",
  description: "",
  files: [
    {
      path: "src/db/users.ts",
      language: "typescript",
      status: "modified",
      commentableLines: [40, 41, 42, 43],
      addedLines: [42],
      hunks: [{ rightStart: 40, rightEnd: 43, text: "@@ -40,3 +40,4 @@\n a\n b\n+  const q = `SELECT * FROM users WHERE id = ${req.params.id}`;\n c" }],
      imports: [],
      exports: ["findUser"],
    },
  ],
  repoMap: [],
  testPairs: [],
  lintConfigs: [],
  skipped: [],
  chunk: { index: 0, total: 1 },
  ...o,
});
