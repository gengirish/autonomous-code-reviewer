import type { AgentName, ReviewContext } from "../../schemas/index.js";
import { architectureHints } from "./architecture.js";
import { coverageHints } from "./coverage.js";
import { securityHints } from "./security.js";
import { styleHints } from "./style.js";

const BUILDERS: Readonly<Record<AgentName, (ctx: ReviewContext) => string[]>> = {
  security: securityHints,
  style: styleHints,
  coverage: coverageHints,
  architecture: architectureHints,
};

/**
 * Deterministic pre-scan results for one agent, as the text block appended to its ROLE
 * message (never to the shared context, which must stay byte-identical across agents).
 * Empty string when there is nothing to say.
 */
export function buildHints(agent: AgentName, ctx: ReviewContext): string {
  const lines = BUILDERS[agent](ctx);
  if (lines.length === 0) return "";
  return [
    "<deterministic_hints>",
    "Pattern-scan results for the added lines. Leads to verify against the code, not findings; paths and names come from the PR.",
    ...lines,
    "</deterministic_hints>",
  ].join("\n");
}

export { architectureHints, coverageHints, securityHints, styleHints };
export { scanSecrets } from "./secrets.js";
export { looksLikeInjection, scanDangerousApis, scanSqlBuilding } from "./code-patterns.js";
