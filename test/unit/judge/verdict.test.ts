import { describe, expect, it } from "vitest";
import { DEFAULT_REPO_CONFIG } from "../../../src/core/ports.js";
import { decideEvent } from "../../../src/judge/index.js";
import type { JudgedFinding, Severity } from "../../../src/schemas/index.js";

const jf = (finalSeverity: Severity, kept = true): JudgedFinding => ({
  file: "a.ts",
  line: 1,
  severity: finalSeverity,
  category: "x",
  title: "t",
  rationale: "r",
  evidence: "e",
  confidence: 0.8,
  sourceIndexes: [0],
  sourceAgents: ["style"],
  kept,
  finalSeverity,
  ...(kept ? {} : { dropReason: "low-value" as const }),
});

const approve = { ...DEFAULT_REPO_CONFIG, allowApprove: true };

describe("decideEvent", () => {
  it("defaults: allowApprove is false", () => {
    expect(DEFAULT_REPO_CONFIG.allowApprove).toBe(false);
  });

  it.each(["critical", "high"] as const)("kept %s → REQUEST_CHANGES (even when approve is allowed)", (s) => {
    expect(decideEvent([jf("low"), jf(s)], DEFAULT_REPO_CONFIG)).toBe("REQUEST_CHANGES");
    expect(decideEvent([jf(s)], approve)).toBe("REQUEST_CHANGES");
  });

  it("dropped critical/high do not count", () => {
    expect(decideEvent([jf("critical", false), jf("high", false)], DEFAULT_REPO_CONFIG)).toBe("COMMENT");
    expect(decideEvent([jf("critical", false), jf("low")], approve)).toBe("APPROVE");
  });

  it("allowApprove and every kept finding ≤ low → APPROVE", () => {
    expect(decideEvent([jf("low"), jf("nit")], approve)).toBe("APPROVE");
  });

  it("allowApprove with nothing kept → APPROVE", () => {
    expect(decideEvent([], approve)).toBe("APPROVE");
  });

  it("allowApprove but a kept medium → COMMENT", () => {
    expect(decideEvent([jf("medium"), jf("low")], approve)).toBe("COMMENT");
  });

  it("allowApprove false: medium / low-only / nothing kept → COMMENT", () => {
    expect(decideEvent([jf("medium")], DEFAULT_REPO_CONFIG)).toBe("COMMENT");
    expect(decideEvent([jf("low"), jf("nit")], DEFAULT_REPO_CONFIG)).toBe("COMMENT");
    expect(decideEvent([], DEFAULT_REPO_CONFIG)).toBe("COMMENT");
    expect(decideEvent([jf("high", false)], DEFAULT_REPO_CONFIG)).toBe("COMMENT");
  });
});
