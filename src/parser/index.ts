/** Context builder public API (acr-parser). Typed against the frozen ports in src/core/ports.ts. */
import type { BuildReviewContext, IsSkippedPath, RenderContext } from "../core/ports.js";
import { buildReviewContext as build } from "./context-builder.js";
import { renderContext as render } from "./render.js";
import { isSkippedPath as skip } from "./skip.js";

export const buildReviewContext: BuildReviewContext = build;
export const renderContext: RenderContext = render;
export const isSkippedPath: IsSkippedPath = skip;

export { parsePatch } from "./diff-map.js";
export type { DiffHunk, ParsedPatch } from "./diff-map.js";
export { languageForPath } from "./languages.js";
export type { LanguageId } from "./languages.js";
export { DEFAULT_MAX_TOKENS_PER_CHUNK, MAX_CHUNKS, SKIP_REASONS } from "./context-builder.js";
