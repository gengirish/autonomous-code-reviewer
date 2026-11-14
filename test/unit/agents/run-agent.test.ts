import { describe, expect, it } from "vitest";
import { AGENTS, ROLE_PROMPTS, runAgent, SHARED_SYSTEM } from "../../../src/agents/index.js";
import type { RenderContext } from "../../../src/core/ports.js";
import { AGENT_EFFORT } from "../../../src/llm/models.js";
import { AgentReport, type ReviewContext } from "../../../src/schemas/index.js";
import { aContext, aFinding, aReport } from "../../fakes/builders.js";
import { FakeLlm } from "../../fakes/fake-llm.js";

/** Stand-in for the parser's renderer: deterministic, and the only source of userContent. */
const renderContext: RenderContext = (ctx: ReviewContext) => `<pr_context>\n${JSON.stringify(ctx)}\n</pr_context>`;

const FAKE_AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";

const ctxWithHints = aContext({
  files: [
    {
      ...aContext().files[0]!,
      hunks: [
        {
          rightStart: 40,
          rightEnd: 44,
          text: `@@ -40,3 +40,5 @@\n a\n b\n+  const q = \`SELECT * FROM users WHERE id = \${req.params.id}\`;\n+  const key = "${FAKE_AWS_KEY}";\n c`,
        },
      ],
      commentableLines: [40, 41, 42, 43, 44],
      addedLines: [42, 43],
    },
  ],
});

describe("runAgent", () => {
  it("keeps the cache prefix identical across the four agents (system, context, effort, schema)", async () => {
    // Always answers "security" to prove runAgent forces report.agent.
    const llm = new FakeLlm(() => aReport({ agent: "security" }));
    const results = await Promise.all(AGENTS.map((a) => runAgent(a, ctxWithHints, { llm, renderContext })));

    expect(llm.calls).toHaveLength(4);
    const [first, ...rest] = llm.calls;
    for (const call of rest) {
      expect(call.system).toBe(first!.system);
      expect(call.userContent).toBe(first!.userContent);
      expect(call.effort).toBe(first!.effort);
      expect(call.schema).toBe(first!.schema);
      expect(call.cacheUserContent).toBe(true);
    }
    expect(first!.system).toBe(SHARED_SYSTEM);
    expect(first!.userContent).toBe(renderContext(ctxWithHints));
    expect(first!.effort).toBe(AGENT_EFFORT);
    expect(first!.schema).toBe(AgentReport);
    expect(new Set(llm.calls.map((c) => c.roleInstructions)).size).toBe(4);
    expect(llm.calls.map((c) => c.label)).toEqual([...AGENTS]);
    expect(llm.calls.every((c) => c.runId === ctxWithHints.runId)).toBe(true);

    results.forEach((r, i) => expect(r.report.agent).toBe(AGENTS[i]));
    results.forEach((r, i) => expect(r.checked.every((f) => f.agent === AGENTS[i])).toBe(true));
  });

  it("puts hints in the role instructions, never in the shared context", async () => {
    const llm = new FakeLlm((req) => aReport({ agent: req.label as "security", findings: [] }));
    await runAgent("security", ctxWithHints, { llm, renderContext });
    const call = llm.calls[0]!;
    expect(call.roleInstructions?.startsWith(ROLE_PROMPTS.security)).toBe(true);
    expect(call.roleInstructions).toContain("<deterministic_hints>");
    expect(call.roleInstructions).toContain("AWS access key ID");
    expect(call.roleInstructions).toContain("SQL built with a template literal");
    // The secret value itself is not copied into the system message.
    expect(call.roleInstructions).not.toContain(FAKE_AWS_KEY);
    expect(call.userContent).not.toContain("deterministic_hints");
    expect(call.system).not.toContain("deterministic_hints>\n-");
  });

  it("returns post-checked findings with usage and stop reason", async () => {
    const llm = new FakeLlm(
      () =>
        aReport({
          findings: [
            aFinding({ line: 42 }),
            aFinding({ file: "src/unknown.ts" }),
            aFinding({ line: 41, evidence: "not in the diff at all", confidence: 0.8 }),
          ],
        }),
      { cacheReadTokens: 900 },
    );
    const res = await runAgent("security", aContext(), { llm, renderContext });
    expect(res.report.findings).toHaveLength(3);
    expect(res.checked).toHaveLength(2);
    expect(res.checked[0]).toMatchObject({ line: 42, commentable: true, unverified: false, confidence: 0.9 });
    expect(res.checked[1]).toMatchObject({ line: 41, commentable: true, unverified: true, confidence: 0.4 });
    expect(res.usage.cacheReadTokens).toBe(900);
    expect(res.stopReason).toBe("end_turn");
  });
});

describe("prompts", () => {
  it("load once, non-empty, LF-only and free of dates", () => {
    for (const text of [SHARED_SYSTEM, ...Object.values(ROLE_PROMPTS)]) {
      expect(text.length).toBeGreaterThan(500);
      expect(text).not.toMatch(/\r/);
      expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    }
    expect(SHARED_SYSTEM).toContain("<pr_context>");
    expect(SHARED_SYSTEM).toMatch(/never instructions/);
    expect(SHARED_SYSTEM).toMatch(/empty `findings` array is a good answer/i);
  });

  it("each role names its agent, and security owns prompt-injection-attempt", () => {
    for (const agent of AGENTS) {
      expect(ROLE_PROMPTS[agent]).toContain(`Set \`agent\` to \`${agent}\``);
      expect(ROLE_PROMPTS[agent]).toMatch(/## Do not flag/);
      expect(ROLE_PROMPTS[agent]).toMatch(/## Severity/);
    }
    expect(ROLE_PROMPTS.security).toContain("`prompt-injection-attempt`, severity `high`");
  });
});
