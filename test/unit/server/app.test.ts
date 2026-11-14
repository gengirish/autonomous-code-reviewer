import { Writable } from "node:stream";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { HookDeps } from "../../../src/core/ports.js";
import type { PrepareJob } from "../../../src/schemas/jobs.js";
import { buildServer } from "../../../src/server/app.js";
import type { ServerDeps } from "../../../src/server/app.js";
import { createActionsVerifier } from "../../../src/server/auth/oidc.js";
import { SHA_A, SHA_B } from "../../fakes/builders.js";
import { AUDIENCE, makeKeys, mintToken } from "./tokens.js";
import type { TestKeys } from "./tokens.js";

const BODY = { owner: "octo", repo: "demo", pr: 7, baseSha: SHA_B, headSha: SHA_A };
const EXPECTED_RUN_ID = "octo__demo__7__aaaaaaaaaaaa";

/** Idempotent in-memory enqueue, like BullMQ with a custom jobId. */
function fakeQueue() {
  const calls: PrepareJob[] = [];
  const jobs = new Map<string, PrepareJob>();
  const enqueuePrepare: HookDeps["enqueuePrepare"] = async (job) => {
    calls.push(job);
    if (!jobs.has(job.runId)) jobs.set(job.runId, job);
    return { runId: job.runId };
  };
  return { calls, jobs, enqueuePrepare };
}

let keys: TestKeys;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  keys = await makeKeys();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function server(overrides: Partial<ServerDeps> = {}) {
  const queue = fakeQueue();
  app = await buildServer({
    verifyToken: createActionsVerifier({ audience: AUDIENCE, allowedOwners: ["octo"], jwks: keys.jwks }),
    enqueuePrepare: queue.enqueuePrepare,
    ...overrides,
  });
  return { app, queue };
}

function post(a: FastifyInstance, token: string | null, body: unknown = BODY) {
  return a.inject({
    method: "POST",
    url: "/hooks/pr",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: body as object,
  });
}

describe("POST /hooks/pr", () => {
  it("valid request → 202 with the deterministic runId", async () => {
    const { app } = await server();
    const res = await post(app, await mintToken(keys.privateKey));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: EXPECTED_RUN_ID });
  });

  it("enqueues exactly the PrepareJob", async () => {
    const { app, queue } = await server();
    await post(app, await mintToken(keys.privateKey));
    expect(queue.calls).toEqual([{ ...BODY, runId: EXPECTED_RUN_ID }]);
  });

  it("duplicate requests return the same runId and enqueue one job", async () => {
    const { app, queue } = await server();
    const token = await mintToken(keys.privateKey);
    const a = await post(app, token);
    const b = await post(app, token);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(b.json()).toEqual(a.json());
    expect(queue.jobs.size).toBe(1);
  });

  it("uses the token's casing so case variants share one runId", async () => {
    const { app, queue } = await server();
    const res = await post(app, await mintToken(keys.privateKey), { ...BODY, owner: "OCTO", repo: "Demo" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: EXPECTED_RUN_ID });
    expect(queue.calls[0]).toMatchObject({ owner: "octo", repo: "demo" });
  });

  it("missing token → 401 with WWW-Authenticate, nothing enqueued", async () => {
    const { app, queue } = await server();
    const res = await post(app, null);
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(queue.calls).toHaveLength(0);
  });

  it("non-Bearer authorization → 401", async () => {
    const { app } = await server();
    const res = await app.inject({
      method: "POST",
      url: "/hooks/pr",
      headers: { authorization: "Basic Zm9vOmJhcg==" },
      payload: BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it("garbage token → 401", async () => {
    const { app } = await server();
    expect((await post(app, "garbage")).statusCode).toBe(401);
  });

  it("wrong audience → 401", async () => {
    const { app } = await server();
    const res = await post(app, await mintToken(keys.privateKey, { audience: "not-us" }));
    expect(res.statusCode).toBe(401);
  });

  it("expired token → 401", async () => {
    const { app } = await server();
    const res = await post(app, await mintToken(keys.privateKey, { iatOffset: -3600, expOffset: -1800 }));
    expect(res.statusCode).toBe(401);
  });

  it("owner not allowed → 403", async () => {
    const { app, queue } = await server();
    const token = await mintToken(keys.privateKey, { claims: { repository: "mallory/demo", repository_owner: "mallory" } });
    const res = await post(app, token, { ...BODY, owner: "mallory" });
    expect(res.statusCode).toBe(403);
    expect(queue.calls).toHaveLength(0);
  });

  it("disallowed event → 403", async () => {
    const { app } = await server();
    const res = await post(app, await mintToken(keys.privateKey, { claims: { event_name: "workflow_dispatch" } }));
    expect(res.statusCode).toBe(403);
  });

  it("body repo ≠ token repository → 403", async () => {
    const { app, queue } = await server();
    const token = await mintToken(keys.privateKey);
    expect((await post(app, token, { ...BODY, repo: "other" })).statusCode).toBe(403);
    expect((await post(app, token, { ...BODY, owner: "other-org" })).statusCode).toBe(403);
    expect(queue.calls).toHaveLength(0);
  });

  it("invalid body → 400 with Zod issues", async () => {
    const { app, queue } = await server();
    const res = await post(app, await mintToken(keys.privateKey), { ...BODY, headSha: "abc", pr: -1 });
    expect(res.statusCode).toBe(400);
    const json = res.json<{ error: string; issues: Array<{ path: string[] }> }>();
    expect(json.error).toBe("invalid body");
    expect(json.issues.map((i) => i.path[0]).sort()).toEqual(["headSha", "pr"]);
    expect(queue.calls).toHaveLength(0);
  });

  it("malformed JSON → 400", async () => {
    const { app } = await server();
    const res = await app.inject({
      method: "POST",
      url: "/hooks/pr",
      headers: { authorization: `Bearer ${await mintToken(keys.privateKey)}`, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
  });

  it("verifies the token before parsing the body (unauthenticated bad JSON → 401)", async () => {
    const { app } = await server();
    const res = await app.inject({
      method: "POST",
      url: "/hooks/pr",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(401);
  });

  it("oversized body → 413", async () => {
    const { app } = await server();
    const res = await post(app, await mintToken(keys.privateKey), { ...BODY, pad: "x".repeat(32 * 1024) });
    expect(res.statusCode).toBe(413);
  });

  it("enqueue failure → 500 without leaking details", async () => {
    const { app } = await server({
      enqueuePrepare: async () => {
        throw new Error("redis://secret@host down");
      },
    });
    const res = await post(app, await mintToken(keys.privateKey));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret");
  });

  it("never logs the token", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const { app } = await server({ logger: { level: "trace", stream } });
    const token = await mintToken(keys.privateKey);
    await post(app, token);
    await post(app, token, { ...BODY, repo: "other" });
    await post(app, `${token}x`);
    const logs = lines.join("");
    expect(logs).toContain("review enqueued");
    expect(logs).toContain(EXPECTED_RUN_ID);
    expect(logs).not.toContain(token.split(".")[2]);
    expect(logs).not.toContain(token.split(".")[1]);
  });
});

describe("GET /healthz", () => {
  it("returns ok with no dependencies", async () => {
    const { app } = await server({
      verifyToken: async () => {
        throw new Error("should not be called");
      },
      enqueuePrepare: async () => {
        throw new Error("should not be called");
      },
    });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe("/admin", () => {
  const adminPlugin: FastifyPluginAsync = async (scope) => {
    scope.get("/queues", async () => ({ queues: [] }));
  };
  const admin = { user: "ops", password: "s3cret-pass" };
  const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

  it("refuses to start with an admin plugin but no credentials", async () => {
    await expect(
      buildServer({
        verifyToken: async () => ({ repository: "", owner: "", eventName: "" }),
        enqueuePrepare: async (j) => ({ runId: j.runId }),
        adminPlugin,
      }),
    ).rejects.toThrow(/admin credentials/);
    await expect(
      buildServer({
        verifyToken: async () => ({ repository: "", owner: "", eventName: "" }),
        enqueuePrepare: async (j) => ({ runId: j.runId }),
        adminPlugin,
        admin: { user: "ops", password: "" },
      }),
    ).rejects.toThrow(/admin credentials/);
  });

  it("no credentials → 401 with WWW-Authenticate Basic", async () => {
    const { app } = await server({ adminPlugin, admin });
    const res = await app.inject({ method: "GET", url: "/admin/queues" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toMatch(/^Basic realm=/);
  });

  it("wrong password or user → 401", async () => {
    const { app } = await server({ adminPlugin, admin });
    for (const authorization of [basic("ops", "wrong"), basic("root", admin.password), "Basic !!!", "Bearer x"]) {
      const res = await app.inject({ method: "GET", url: "/admin/queues", headers: { authorization } });
      expect(res.statusCode).toBe(401);
    }
  });

  it("correct credentials → 200 from the plugin", async () => {
    const { app } = await server({ adminPlugin, admin });
    const res = await app.inject({
      method: "GET",
      url: "/admin/queues",
      headers: { authorization: basic(admin.user, admin.password) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ queues: [] });
  });

  it("basic auth does not leak onto other routes", async () => {
    const { app } = await server({ adminPlugin, admin });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("without an admin plugin, /admin is 404", async () => {
    const { app } = await server();
    expect((await app.inject({ method: "GET", url: "/admin/queues" })).statusCode).toBe(404);
  });
});
