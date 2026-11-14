// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cartRepository } from "../repositories/cartRepository";
import purgeAbandonedCarts from "./purgeAbandonedCarts";

vi.mock("../repositories/cartRepository", () => ({
  cartRepository: { findIdsUpdatedBefore: vi.fn(), deleteMany: vi.fn() },
}));

const repo = vi.mocked(cartRepository);

describe("purgeAbandonedCarts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("deletes abandoned carts last updated more than 30 days ago", async () => {
    repo.findIdsUpdatedBefore.mockResolvedValue(["c1", "c2"]);
    repo.deleteMany.mockResolvedValue(2);

    const deleted = await purgeAbandonedCarts(new Date("2026-06-30T03:30:00Z"));

    expect(repo.findIdsUpdatedBefore).toHaveBeenCalledWith(new Date("2026-05-31T03:30:00Z"), { status: "abandoned" });
    expect(repo.deleteMany).toHaveBeenCalledWith(["c1", "c2"]);
    expect(deleted).toBe(2);
  });

  it("does nothing when there is nothing to purge", async () => {
    repo.findIdsUpdatedBefore.mockResolvedValue([]);

    expect(await purgeAbandonedCarts()).toBe(0);
    expect(repo.deleteMany).not.toHaveBeenCalled();
  });
});
