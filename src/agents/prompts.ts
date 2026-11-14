import { readFileSync } from "node:fs";
import type { AgentName } from "../schemas/index.js";

/** Resolved relative to this module, so it works from src/ (tsx, vitest) and dist/ (copy-assets). */
const PROMPTS_DIR = new URL("./prompts/", import.meta.url);

/** Normalised to LF and trimmed so the bytes are identical whatever the checkout's line endings (cache prefix). */
const load = (name: string): string =>
  readFileSync(new URL(`${name}.md`, PROMPTS_DIR), "utf8").replace(/\r\n?/g, "\n").trim();

/** Frozen top-level system prompt, identical for all four agents. */
export const SHARED_SYSTEM: string = load("_shared");

/** Role prompts, sent as the mid-conversation system message after the cached context. */
export const ROLE_PROMPTS: Readonly<Record<AgentName, string>> = Object.freeze({
  security: load("security"),
  style: load("style"),
  coverage: load("coverage"),
  architecture: load("architecture"),
});
