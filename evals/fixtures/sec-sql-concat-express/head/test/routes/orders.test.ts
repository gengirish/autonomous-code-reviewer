// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app";
import { pool } from "../../src/db/pool";

vi.mock("../../src/db/pool", () => ({ pool: { query: vi.fn() } }));
vi.mock("../../src/middleware/auth", () => ({
  requireAuth: (req: { user?: { customerId: string } }, _res: unknown, next: () => void) => {
    req.user = { customerId: "c_123" };
    next();
  },
}));

const query = vi.mocked(pool.query);

describe("GET /orders", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("lists the caller's orders, newest first by default", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: "o1" }] } as never);

    const res = await request(buildApp()).get("/orders");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orders: [{ id: "o1" }] });
    expect(query.mock.calls[0]?.[0]).toContain("ORDER BY created_at DESC LIMIT 20");
    expect(query.mock.calls[0]?.[1]).toEqual(["c_123"]);
  });

  it("filters by status", async () => {
    query.mockResolvedValueOnce({ rows: [] } as never);

    await request(buildApp()).get("/orders?status=shipped");

    expect(query.mock.calls[0]?.[0]).toContain("AND status = 'shipped'");
  });

  it("falls back to created_at for unknown sort columns", async () => {
    query.mockResolvedValueOnce({ rows: [] } as never);

    await request(buildApp()).get("/orders?sort=password_hash");

    expect(query.mock.calls[0]?.[0]).toContain("ORDER BY created_at DESC");
  });

  it("caps the page size at 100", async () => {
    query.mockResolvedValueOnce({ rows: [] } as never);

    await request(buildApp()).get("/orders?limit=5000");

    expect(query.mock.calls[0]?.[0]).toContain("LIMIT 100");
  });
});
