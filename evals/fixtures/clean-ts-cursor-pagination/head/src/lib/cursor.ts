// @ts-nocheck -- eval fixture: sample code under review, not project code (header stripped by evals/fixture-source.ts)
import { z } from "zod";

/**
 * Opaque keyset-pagination cursor: the sort key and id of the last row on a page.
 * Clients must treat it as an opaque string; only this module knows its shape.
 */
const CursorPayload = z.object({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});
export type CursorPayload = z.infer<typeof CursorPayload>;

export class InvalidCursorError extends Error {
  constructor() {
    super("invalid pagination cursor");
    this.name = "InvalidCursorError";
  }
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** Decodes a cursor received from a client. Throws InvalidCursorError for anything malformed. */
export function decodeCursor(cursor: string): CursorPayload {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  const parsed = CursorPayload.safeParse(json);
  if (!parsed.success) throw new InvalidCursorError();
  return parsed.data;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Builds a page from `limit + 1` fetched rows: the extra row only tells us whether
 * another page exists and is never returned.
 */
export function toPage<T extends { id: string; createdAt: Date }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null,
  };
}
