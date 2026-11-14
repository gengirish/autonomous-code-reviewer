/**
 * web-tree-sitter (≥ 0.25 API: named `Parser` / `Language` exports).
 *
 * - `Parser.init()` runs once per process (lazily, memoised promise).
 * - One `Language` and one `Parser` per grammar, cached and reused.
 * - Grammar paths come from `import.meta.url`, so this works from `src/` (tsx/vitest)
 *   and from `dist/` (the build copies `src/parser/grammars` to `dist/parser/grammars`).
 * - Callers must not keep a `Tree` around: use `withTree`, which always calls `tree.delete()`.
 */
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Language, Parser } from "web-tree-sitter";
import type { Tree } from "web-tree-sitter";
import { grammarFileFor } from "./languages.js";
import type { LanguageId } from "./languages.js";

const GRAMMARS_DIR = fileURLToPath(new URL("./grammars/", import.meta.url));

export function grammarPath(file: string): string {
  return join(GRAMMARS_DIR, file);
}

let initPromise: Promise<void> | null = null;
const languages = new Map<LanguageId, Promise<Language>>();
const parsers = new Map<LanguageId, Parser>();

function init(): Promise<void> {
  initPromise ??= Parser.init().catch((err: unknown) => {
    initPromise = null; // allow a retry after a failed init
    throw err;
  });
  return initPromise;
}

export async function loadLanguage(lang: LanguageId): Promise<Language> {
  await init();
  let p = languages.get(lang);
  if (!p) {
    p = Language.load(grammarPath(grammarFileFor(lang)));
    p.catch(() => languages.delete(lang));
    languages.set(lang, p);
  }
  return p;
}

async function parserFor(lang: LanguageId): Promise<Parser> {
  const language = await loadLanguage(lang);
  let parser = parsers.get(lang);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(lang, parser);
  }
  return parser;
}

/**
 * Parses `source` and hands the tree to `fn`. The tree is deleted afterwards (WASM memory),
 * so `fn` must copy out everything it needs (strings, numbers), never nodes.
 */
export async function withTree<T>(lang: LanguageId, source: string, fn: (tree: Tree) => T): Promise<T> {
  const parser = await parserFor(lang);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter failed to parse (${lang})`);
  try {
    return fn(tree);
  } finally {
    tree.delete();
  }
}
