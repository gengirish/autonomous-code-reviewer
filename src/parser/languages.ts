/** File extension → tree-sitter language and its vendored grammar (src/parser/grammars/). */

export type LanguageId = "typescript" | "tsx" | "javascript" | "python" | "go";

export const GRAMMAR_FILES: Readonly<Record<LanguageId, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  // The JavaScript grammar parses JSX too, so .jsx uses it.
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
};

const BY_EXTENSION: Readonly<Record<string, LanguageId>> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
};

/** Lower-cased extension of the last path segment including the dot ("" when none). */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** Language for a path, or null when we have no grammar for it (diff-only context). */
export function languageForPath(path: string): LanguageId | null {
  // `.d.ts` is still TypeScript; the generic lookup handles it.
  return BY_EXTENSION[extensionOf(path)] ?? null;
}

export function grammarFileFor(lang: LanguageId): string {
  return GRAMMAR_FILES[lang];
}
