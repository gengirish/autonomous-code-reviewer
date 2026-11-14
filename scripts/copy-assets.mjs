// Copies non-TS runtime assets into dist/ after tsc.
import { cpSync, mkdirSync } from "node:fs";

const assets = [
  ["src/parser/grammars", "dist/parser/grammars"],
  ["src/agents/prompts", "dist/agents/prompts"],
  ["src/judge/prompt.md", "dist/judge/prompt.md"],
  ["src/judge/rubric.md", "dist/judge/rubric.md"],
];
for (const [from, to] of assets) {
  try {
    mkdirSync(to.replace(/\/[^/]+\.md$/, ""), { recursive: true });
    cpSync(from, to, { recursive: true });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}
