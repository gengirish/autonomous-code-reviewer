import { describe, expect, it } from "vitest";
import { AgentReport, HookBody, ReviewContext, runKey } from "../../../src/schemas/index.js";
import { aContext, aReport, SHA_A, SHA_B } from "../../fakes/builders.js";

describe("schemas", () => {
  it("accepts a valid hook body and rejects a short SHA", () => {
    const ok = { owner: "octo", repo: "demo", pr: 7, baseSha: SHA_B, headSha: SHA_A };
    expect(HookBody.parse(ok)).toEqual(ok);
    expect(() => HookBody.parse({ ...ok, headSha: "abc" })).toThrow();
  });

  it("builds a run key without ':' (BullMQ rejects it in custom job IDs)", () => {
    const key = runKey({ owner: "octo", repo: "demo", pr: 7 }, SHA_A);
    expect(key).toBe("octo__demo__7__aaaaaaaaaaaa");
    expect(key).not.toContain(":");
  });

  it("builders produce valid objects", () => {
    expect(() => AgentReport.parse(aReport())).not.toThrow();
    expect(() => ReviewContext.parse(aContext())).not.toThrow();
  });

  it("blocks non-localhost network in tests", async () => {
    await expect(fetch("https://api.anthropic.com")).rejects.toThrow(/blocked/);
  });
});
