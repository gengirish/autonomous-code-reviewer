import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { RunStats, StatsReader } from "../../../src/core/ports.js";
import { buildServer } from "../../../src/server/app.js";
import type { ServerDeps } from "../../../src/server/app.js";

const ADMIN = { user: "admin", password: "s3cret" };
const AUTH = `Basic ${Buffer.from(`${ADMIN.user}:${ADMIN.password}`).toString("base64")}`;

const STATS: RunStats = {
  owner: "octo",
  repo: "demo",
  sinceDays: 30,
  runs: 3,
  avgCostUsd: 0.21,
  avgLatencyMs: 95_000,
};

/** Records every call; returns `result` for any input. */
function fakeStats(result: RunStats | null = STATS) {
  const calls: Array<[string, string, number]> = [];
  const reader: StatsReader = {
    async repoStats(owner, repo, sinceDays) {
      calls.push([owner, repo, sinceDays]);
      return result;
    },
  };
  return { calls, reader };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function server(overrides: Partial<ServerDeps> = {}) {
  app = await buildServer({
    verifyToken: async () => {
      throw new Error("not used");
    },
    enqueuePrepare: async (job) => ({ runId: job.runId }),
    ...overrides,
  });
  return app;
}

function get(a: FastifyInstance, query: string, auth: string | null = AUTH) {
  return a.inject({
    method: "GET",
    url: `/admin/stats/runs${query}`,
    headers: auth === null ? {} : { authorization: auth },
  });
}

describe("GET /admin/stats/runs", () => {
  it("returns the repo's stats and defaults days to 30", async () => {
    const stats = fakeStats();
    const a = await server({ admin: ADMIN, stats: stats.reader });
    const res = await get(a, "?owner=octo&repo=demo");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(STATS);
    expect(stats.calls).toEqual([["octo", "demo", 30]]);
  });

  it("passes an explicit days window through as a number", async () => {
    const stats = fakeStats();
    const a = await server({ admin: ADMIN, stats: stats.reader });
    expect((await get(a, "?owner=octo&repo=demo&days=7")).statusCode).toBe(200);
    expect(stats.calls).toEqual([["octo", "demo", 7]]);
  });

  it("401 without credentials, and the reader is never called", async () => {
    const stats = fakeStats();
    const a = await server({ admin: ADMIN, stats: stats.reader });
    const res = await get(a, "?owner=octo&repo=demo", null);
    expect(res.statusCode).toBe(401);
    expect(stats.calls).toEqual([]);
  });

  it("401 with a wrong password", async () => {
    const stats = fakeStats();
    const a = await server({ admin: ADMIN, stats: stats.reader });
    const wrong = `Basic ${Buffer.from("admin:nope").toString("base64")}`;
    expect((await get(a, "?owner=octo&repo=demo", wrong)).statusCode).toBe(401);
    expect(stats.calls).toEqual([]);
  });

  it.each([
    ["missing repo", "?owner=octo"],
    ["missing owner", "?repo=demo"],
    ["SQL in repo", `?owner=octo&repo=${encodeURIComponent("demo' OR '1'='1")}`],
    ["SQL in days", `?owner=octo&repo=demo&days=${encodeURIComponent("1 days'; DROP TABLE x; --")}`],
    ["days = 0", "?owner=octo&repo=demo&days=0"],
    ["days > 365", "?owner=octo&repo=demo&days=366"],
    ["fractional days", "?owner=octo&repo=demo&days=1.5"],
  ])("400 for %s, and the reader is never called", async (_name, query) => {
    const stats = fakeStats();
    const a = await server({ admin: ADMIN, stats: stats.reader });
    const res = await get(a, query);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid query" });
    expect(stats.calls).toEqual([]);
  });

  it("404 when the repo has no runs in the window", async () => {
    const a = await server({ admin: ADMIN, stats: fakeStats(null).reader });
    const res = await get(a, "?owner=octo&repo=demo");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "no runs in window" });
  });

  it("is not registered at all without admin credentials (fails closed)", async () => {
    const stats = fakeStats();
    const a = await server({ stats: stats.reader });
    expect((await get(a, "?owner=octo&repo=demo", null)).statusCode).toBe(404);
    expect(stats.calls).toEqual([]);
  });

  it.each([
    ["empty user", { user: "", password: "s3cret" }],
    ["empty password", { user: "admin", password: "" }],
  ])("refuses to start with stats and %s", async (_name, admin) => {
    await expect(server({ admin, stats: fakeStats().reader })).rejects.toThrow(/non-empty user and password/);
  });

  it("shares one /admin auth scope with the admin plugin", async () => {
    const adminPlugin = async (scope: FastifyInstance) => {
      scope.get("/queues", async () => ({ board: true }));
    };
    const a = await server({ admin: ADMIN, adminPlugin, stats: fakeStats().reader });
    expect((await a.inject({ method: "GET", url: "/admin/queues", headers: { authorization: AUTH } })).json()).toEqual({
      board: true,
    });
    expect((await get(a, "?owner=octo&repo=demo")).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: "/admin/queues" })).statusCode).toBe(401);
    expect((await get(a, "?owner=octo&repo=demo", null)).statusCode).toBe(401);
  });

  it("is not served on the old public path", async () => {
    const a = await server({ admin: ADMIN, stats: fakeStats().reader });
    const res = await a.inject({ method: "GET", url: "/stats/runs?owner=octo&repo=demo" });
    expect(res.statusCode).toBe(404);
  });
});
