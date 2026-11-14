import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURES = new URL("./fixtures/", import.meta.url);

/** Reads a fixture as UTF-8 with LF line endings (stable across Windows checkouts). */
export function fixture(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, FIXTURES)), "utf8").replace(/\r\n/g, "\n");
}

export const patch = (name: string): string => fixture(`patches/${name}.patch`);
/** Source fixtures carry a `.txt` suffix so tsc, eslint and vitest leave them alone. */
export const source = (name: string): string => fixture(`src/${name}.txt`);

/** 1-based line number of the first line containing `needle`. */
export function lineOf(text: string, needle: string): number {
  const idx = text.split("\n").findIndex((l) => l.includes(needle));
  if (idx < 0) throw new Error(`not found: ${needle}`);
  return idx + 1;
}
