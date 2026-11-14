// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
import { describe, expect, it } from "vitest";
import { InvalidCursorError, decodeCursor, encodeCursor, toPage } from "./cursor";

const row = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  createdAt: new Date(Date.UTC(2026, 0, n)),
});

describe("cursor encoding", () => {
  it("round-trips a payload", () => {
    const payload = { createdAt: "2026-01-02T00:00:00.000Z", id: row(2).id };
    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
  });

  it.each([
    ["not base64 json", "%%%"],
    ["valid json, wrong shape", Buffer.from(JSON.stringify({ id: 1 })).toString("base64url")],
    ["empty string", ""],
  ])("rejects %s", (_name, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(InvalidCursorError);
  });
});

describe("toPage", () => {
  it("returns a cursor for the last item when more rows exist", () => {
    const page = toPage([row(1), row(2), row(3)], 2);
    expect(page.items).toEqual([row(1), row(2)]);
    expect(page.nextCursor && decodeCursor(page.nextCursor)).toEqual({
      createdAt: row(2).createdAt.toISOString(),
      id: row(2).id,
    });
  });

  it("returns no cursor on the last page", () => {
    expect(toPage([row(1)], 2)).toEqual({ items: [row(1)], nextCursor: null });
  });

  it("handles an empty result", () => {
    expect(toPage([], 10)).toEqual({ items: [], nextCursor: null });
  });
});
