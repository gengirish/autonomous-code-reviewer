import { describe, expect, it } from "vitest";
import { noopRecorder } from "../../../src/core/recorder.js";
import { createDbFromEnv, createRecorderFromEnv } from "../../../src/db/index.js";

// "" (not undefined) so the test never falls back to a DATABASE_URL from the environment.
describe("createDbFromEnv without a database", () => {
  it("returns the no-op recorder and no stats reader", async () => {
    const db = createDbFromEnv("");
    expect(db.recorder).toBe(noopRecorder);
    expect(db.stats).toBeUndefined();
    await expect(db.close()).resolves.toBeUndefined();
  });
});

describe("createRecorderFromEnv without a database", () => {
  it("is the no-op recorder plus a close() that resolves", async () => {
    const rec = createRecorderFromEnv("");
    expect(Object.keys(rec).sort()).toEqual([...Object.keys(noopRecorder), "close"].sort());
    await expect(rec.runStatus("r", "RUNNING")).resolves.toBeUndefined();
    await expect(rec.close()).resolves.toBeUndefined();
  });
});
