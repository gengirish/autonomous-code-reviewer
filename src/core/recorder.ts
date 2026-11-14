import type { RunRecorder } from "./ports.js";

/** Default recorder when no database is configured (dev, tests, evals). */
export const noopRecorder: RunRecorder = {
  async runQueued() {},
  async runStatus() {},
  async agentReport() {},
  async llmCall() {},
  async findings() {},
  async runFinished() {},
};
