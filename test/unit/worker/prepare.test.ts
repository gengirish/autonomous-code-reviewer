import { UnrecoverableError, type FlowJob } from "bullmq";
import { describe, expect, it } from "vitest";
import { NotReviewableError } from "../../../src/core/errors.js";
import type { PrFile } from "../../../src/core/ports.js";
import type { PrRef } from "../../../src/schemas/index.js";
import { NO_PATCH_REASON, processPrepare } from "../../../src/worker/processors/prepare.js";
import { SHA_A, SHA_B } from "../../fakes/builders.js";
import { FakePrSource } from "../../fakes/fake-github.js";
import { aFile, aMeta, makeDeps, prepareJob, REF, RUN_ID, stubBuildReviewContext } from "./stubs.js";

const job = (data: unknown = prepareJob()) => ({ id: RUN_ID, data, timestamp: 1_000 });

describe("processPrepare", () => {
  it("stores contexts, adds the flow and marks the run RUNNING", async () => {
    const files = [
      aFile({ path: "src/a.ts" }),
      aFile({ path: "package-lock.lock" }),
      aFile({ path: "assets/logo.png", patch: undefined }),
      aFile({ path: "src/old.ts", status: "removed" }),
    ];
    const source = new FakePrSource(aMeta(), files, { "src/a.ts": "a" }, { ".eslintrc.json": "{}", "ruff.toml": "x" });
    let seen: Parameters<ReturnType<typeof stubBuildReviewContext>>[0] | undefined;
    const deps = makeDeps({ source, buildReviewContext: stubBuildReviewContext(2, (input) => void (seen = input)) });

    const res = await processPrepare(job(), deps);

    expect(res).toEqual({ status: "queued", runId: RUN_ID, chunks: 2, files: 4, skipped: 2 });
    expect(await deps.contextStore.getLatest(REF)).toBe(SHA_A);
    expect(source.calls).toEqual(["getPr", "listFiles", "getContent:src/a.ts"]); // removed file: no head fetch
    expect(seen?.files).toHaveLength(4);
    expect([...seen!.contents.keys()].sort()).toEqual(["src/a.ts", "src/old.ts"]);
    expect([...seen!.lintConfigs.keys()].sort()).toEqual([".eslintrc.json", "ruff.toml"]);

    const contexts = await deps.contextStore.getContexts(RUN_ID);
    expect(contexts).toHaveLength(2);
    expect(contexts![0]!.skipped).toEqual([
      { path: "package-lock.lock", reason: "generated or lockfile" },
      { path: "assets/logo.png", reason: NO_PATCH_REASON },
    ]);

    expect(deps.flowCalls).toHaveLength(1);
    const flow = deps.flowCalls[0] as FlowJob;
    expect(flow.data).toEqual({ runId: RUN_ID, startedAt: 1_000 });
    expect(flow.children?.[0]?.children).toHaveLength(8); // 4 agents × 2 chunks
    expect(deps.recorder.statuses()).toEqual(["RUNNING"]);
  });

  it.each([
    ["draft", aMeta({ draft: true }), "PR is a draft"],
    ["closed", aMeta({ state: "closed" }), "PR is closed"],
  ])("skips a %s PR without listing files", async (_name, meta, reason) => {
    const source = new FakePrSource(meta, [aFile()], {});
    const deps = makeDeps({ source });
    expect(await processPrepare(job(), deps)).toEqual({ status: "skipped", reason });
    expect(source.calls).toEqual(["getPr"]);
    expect(deps.flowCalls).toHaveLength(0);
    expect(deps.recorder.of("runStatus")).toEqual([{ type: "runStatus", runId: RUN_ID, status: "SKIPPED", error: reason }]);
  });

  it("marks the run SUPERSEDED when the PR head moved, and claims latest with the real head", async () => {
    const source = new FakePrSource(aMeta({ headSha: SHA_B }), [aFile()], {});
    const deps = makeDeps({ source });
    expect(await processPrepare(job(), deps)).toEqual({ status: "superseded", latestSha: SHA_B });
    expect(await deps.contextStore.getLatest(REF)).toBe(SHA_B);
    expect(source.calls).toEqual(["getPr"]);
    expect(deps.recorder.statuses()).toEqual(["SUPERSEDED"]);
    expect(deps.flowCalls).toHaveLength(0);
  });

  it("skips when the parser returns no contexts", async () => {
    const deps = makeDeps({ buildReviewContext: async () => [] });
    expect(await processPrepare(job(), deps)).toEqual({ status: "skipped", reason: "no reviewable files" });
    expect(deps.flowCalls).toHaveLength(0);
  });

  it("rejects a malformed payload as unrecoverable", async () => {
    await expect(processPrepare(job({ runId: RUN_ID }), makeDeps())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("maps a permanent error to UnrecoverableError and records FAILED", async () => {
    const deps = makeDeps({
      prSourceFor: async () => {
        throw new NotReviewableError("app not installed");
      },
    });
    await expect(processPrepare(job(), deps)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(deps.recorder.of("runStatus")).toEqual([{ type: "runStatus", runId: RUN_ID, status: "FAILED", error: "app not installed" }]);
  });

  it("rethrows a transient error for retry", async () => {
    const source = new FakePrSource(aMeta(), [aFile({ path: "missing.ts" })], {});
    const err = await processPrepare(job(), makeDeps({ source })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
  });

  it("fetches contents with at most 8 requests in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    class SlowSource extends FakePrSource {
      override async getContent(ref: PrRef, file: PrFile) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return super.getContent(ref, file);
      }
    }
    const files = Array.from({ length: 30 }, (_, i) => aFile({ path: `src/f${i}.ts` }));
    const source = new SlowSource(aMeta(), files, Object.fromEntries(files.map((f) => [f.path, "x"])));
    await processPrepare(job(), makeDeps({ source }));
    expect(peak).toBe(8);
  });
});
