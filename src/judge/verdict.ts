import type { DecideEvent } from "../core/ports.js";

/**
 * The verdict is decided in code, never by the model (acr-judge):
 * - any kept critical/high → REQUEST_CHANGES
 * - allowApprove and every kept finding is low or nit (including none kept) → APPROVE
 * - otherwise → COMMENT
 */
export const decideEvent: DecideEvent = (findings, cfg) => {
  const kept = findings.filter((f) => f.kept);
  if (kept.some((f) => f.finalSeverity === "critical" || f.finalSeverity === "high")) return "REQUEST_CHANGES";
  if (cfg.allowApprove && kept.every((f) => f.finalSeverity === "nit" || f.finalSeverity === "low")) return "APPROVE";
  return "COMMENT";
};
