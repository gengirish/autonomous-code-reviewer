/** A realistic small PR built from the patch/source fixtures, as BuildReviewContext input. */
import type { PrFile, PrMeta } from "../../../../src/core/ports.js";
import { SHA_A, SHA_B } from "../../../fakes/builders.js";
import { patch, source } from "../helpers.js";

export const meta: PrMeta = {
  headSha: SHA_A,
  baseSha: SHA_B,
  title: "Parameterise user lookup and hash with sha256",
  body: "Fixes the SQL injection in `UserService.find`.\r\n\r\nAlso removes the old cleanup script.",
  draft: false,
  state: "open",
};

export const ref = { owner: "octo", repo: "demo", pr: 7 };

export const files: PrFile[] = [
  { path: "src/services/user-service.ts", status: "modified", patch: patch("multi-hunk"), blobSha: "1", additions: 5, deletions: 2 },
  { path: "src/services/user-service.test.ts", status: "added", patch: patch("new-file"), blobSha: "2", additions: 8, deletions: 0 },
  { path: "src/legacy/cleanup.py", status: "removed", patch: patch("deletion-only"), blobSha: "3", additions: 0, deletions: 6 },
  {
    path: "src/utils/helpers.ts",
    previousPath: "src/old/helpers.ts",
    status: "renamed",
    patch: patch("rename"),
    blobSha: "4",
    additions: 1,
    deletions: 1,
  },
  { path: "docs/notes.md", status: "modified", patch: patch("no-newline"), blobSha: "5", additions: 1, deletions: 1 },
  { path: "package-lock.json", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b", blobSha: "6", additions: 1, deletions: 1 },
  { path: "assets/logo.png", status: "added", blobSha: "7", additions: 0, deletions: 0 },
  { path: "src/big-data.ts", status: "modified", blobSha: "8", additions: 4000, deletions: 10 },
  { path: "src/gone.ts", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b", blobSha: "9", additions: 1, deletions: 1 },
];

export const contents = new Map<string, string>([
  ["src/services/user-service.ts", source("user-service.ts")],
  ["src/services/user-service.test.ts", source("user-service.test.ts")],
  ["src/utils/helpers.ts", 'export function slugify(s: string): string {\n  return s.toLowerCase().replace(/\\s+/g, "-");\n}\n\n'],
  ["docs/notes.md", "const a = 1;\nconst b = 2;\nconst c = 4;"],
]);

export const lintConfigs = new Map<string, string>([
  ["eslint.config.js", "export default [];\n"],
  [".prettierrc", '{ "semi": true }\n'],
]);

export const input = () => ({ runId: "octo__demo__7__aaaaaaaaaaaa", ref, meta, files, contents, lintConfigs });
