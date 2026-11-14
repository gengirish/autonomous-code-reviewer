---
name: acr-parser
description: >-
  ACR's context builder: parsing unified-diff hunks into RIGHT-side line maps, parsing
  head-version files with web-tree-sitter, finding the function or class around each
  change, the repo map and import graph, the ReviewContext type, token budgeting and
  chunking of large PRs. Use when editing src/parser/, adding a language grammar,
  fixing wrong inline-comment line numbers, or handling large diffs.
---

# Context builder (src/parser)

**Core fact:** a diff can't be parsed into an AST. We parse the **full head-version file**
and use the diff only to know *which lines changed*.

## Steps (prepare processor)

1. **Filter** files (`acr-github` skip rules).
2. **Diff map** (`diff-map.ts`): for each file's `patch`, parse `@@ -a,b +c,d @@` headers and
   walk the lines:
   - `+` line → RIGHT line `n`, added, `n++`
   - ` ` line → RIGHT line `n`, context, `n++`
   - `-` line → LEFT only (no RIGHT line)
   - `\ No newline at end of file` → ignore

   Output `{ addedLines: Set<number>, commentableLines: Set<number>, hunks: Hunk[] }`.
   `commentableLines` (added + context) is **the only set the publisher may use for inline
   comments**. This is the module most worth unit-testing: use real patches with renames,
   deletions-only, multiple hunks and a no-newline marker.
3. **Parse** each file whose language has a grammar. Others get diff-only context.
4. **Enclosing symbol** per hunk: `root.descendantForPosition({ row: line - 1, column: 0 })`
   (tree-sitter rows are 0-based), then walk `.parent` until the node type is in the
   language's symbol set. Capture name, signature line, full body text and its start/end lines.
5. **File facts:** imports and exports. **Repo map** for touched modules: top-level symbols
   of the touched files plus the files they import (one hop). Used by Architecture.
6. **Test pairing:** for each changed source file, look for changed test files that match it
   (`x.ts` ↔ `x.test.ts`, `__tests__/x.ts`, `tests/test_x.py`). Used by Coverage.
7. **Budget** (below), then store `ReviewContext` at Redis `ctx:<runId>` (TTL 1 h).

## web-tree-sitter (src/parser/treesitter.ts)

The API changed at 0.25: named exports `Parser` and `Language`, whereas older versions use
a default export with `Parser.Language.load`. **Check the installed version first.**

```ts
import { Parser, Language } from "web-tree-sitter";   // ≥ 0.25
await Parser.init();
const ts = await Language.load(grammarPath("tree-sitter-typescript.wasm"));
const parser = new Parser();
parser.setLanguage(ts);
const tree = parser.parse(source);
```

- Grammars are vendored in `src/parser/grammars/*.wasm`, with versions recorded in
  `grammars/VERSIONS.md`. Copy them into `dist/` at build time. `.ts` and `.tsx` need
  **different** grammars.
- ESM: there's no `__dirname`. Resolve paths with `fileURLToPath(new URL("./grammars/", import.meta.url))`.
- Initialise once per worker process and reuse parsers. Call `tree.delete()` when done to free WASM memory.

Symbol node types (start set, extend as needed):

| Lang | Types |
|---|---|
| TS/JS | `function_declaration`, `method_definition`, `class_declaration`, `arrow_function` / `function_expression` whose parent is a `variable_declarator` (use the declarator's name) |
| Python | `function_definition`, `class_definition` |
| Go | `function_declaration`, `method_declaration`, `type_declaration` |

## ReviewContext (src/schemas/review-context.ts, frozen in phase 2)

```ts
ReviewContext = {
  runId; owner; repo; pr; headSha; baseSha; title; description;   // title/description are UNTRUSTED
  files: Array<{
    path; language: string | null; status: "added" | "modified" | "renamed" | "removed";
    commentableLines: number[];
    hunks: Array<{ rightStart: number; rightEnd: number; text: string;
                   symbol?: { kind: string; name: string; startLine: number; endLine: number; body: string } }>;
    imports: string[]; exports: string[];
  }>;
  repoMap: Array<{ path: string; symbols: string[]; imports: string[] }>;
  testPairs: Array<{ source: string; tests: string[] }>;
  lintConfigs: Array<{ path: string; text: string }>;    // .eslintrc*, prettier, ruff, etc.
  coverage?: Array<{ path: string; uncoveredLines: number[] }>;
  skipped: Array<{ path: string; reason: string }>;      // shown in the review summary
  chunk?: { index: number; total: number };
}
```

Changing this type is a breaking change for agents, evals and fixtures. Update all three together.

## Token budget and chunking

- Render the context deterministically (sorted files, stable formatting) so the prompt
  cache prefix is byte-identical across the four agents (`acr-llm`).
- Count with `client.messages.countTokens` on the rendered context. Target ≤ 60k tokens per chunk.
- If it's over budget, first drop symbol bodies longer than 300 lines (keep the signature and
  hunk). If still over, split into chunks by top-level directory. Each chunk runs its own
  4-agent fan-out, and the judge receives all chunks' reports.
- Hard cap: more than 4 chunks means review the first 4 by changed-line count and list the
  rest in `skipped`. **Never truncate silently.**
