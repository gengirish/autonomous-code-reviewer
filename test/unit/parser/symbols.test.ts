import { describe, expect, it } from "vitest";
import { languageForPath } from "../../../src/parser/languages.js";
import { analyzeSource, findEnclosingSymbol } from "../../../src/parser/symbols.js";
import { lineOf, source } from "./helpers.js";

describe("languageForPath", () => {
  it.each([
    ["a.ts", "typescript"],
    ["a.mts", "typescript"],
    ["a.cts", "typescript"],
    ["types.d.ts", "typescript"],
    ["a.tsx", "tsx"],
    ["a.js", "javascript"],
    ["a.mjs", "javascript"],
    ["a.cjs", "javascript"],
    ["a.jsx", "javascript"],
    ["pkg/a.py", "python"],
    ["cmd/main.go", "go"],
    ["README.md", null],
    ["Makefile", null],
    [".eslintrc", null],
  ])("%s → %s", (path, lang) => {
    expect(languageForPath(path)).toBe(lang);
  });
});

describe("enclosing symbol", () => {
  const ts = source("user-service.ts");

  it("typescript: function declaration", async () => {
    const s = await findEnclosingSymbol("typescript", ts, lineOf(ts, "createHash"));
    expect(s).toMatchObject({ kind: "function_declaration", name: "hashPassword", startLine: 7, endLine: 9 });
    // Bodies are whole source lines, so the `export` keyword on the first line is kept.
    expect(s?.body.split("\n")[0]).toBe("export function hashPassword(password: string): string {");
  });

  it("typescript: method with the class-qualified name", async () => {
    const s = await findEnclosingSymbol("typescript", ts, lineOf(ts, "SELECT *"));
    expect(s).toMatchObject({ kind: "method_definition", name: "UserService.find", startLine: 14, endLine: 17 });
    expect(s?.body).toContain("return rows[0] ?? null;");
  });

  it("typescript: arrow function const takes the declarator name", async () => {
    const s = await findEnclosingSymbol("typescript", ts, lineOf(ts, "user.email"));
    expect(s).toMatchObject({ kind: "arrow_function", name: "formatUser", startLine: 22, endLine: 24 });
    expect(s?.body.startsWith("export const formatUser")).toBe(true);
  });

  it("typescript: arrow class field is class-qualified", async () => {
    const s = await findEnclosingSymbol("typescript", ts, lineOf(ts, "private normalize"));
    expect(s).toMatchObject({ name: "UserService.normalize", startLine: 19, endLine: 19 });
  });

  it("typescript: top-level statements and blank lines have no symbol", async () => {
    expect(await findEnclosingSymbol("typescript", ts, lineOf(ts, "MAX_USERS"))).toBeUndefined();
    expect(await findEnclosingSymbol("typescript", ts, 4)).toBeUndefined();
    expect(await findEnclosingSymbol("typescript", ts, 999)).toBeUndefined();
  });

  it("tsx: function component (skipping the inline callback) and arrow component", async () => {
    const tsx = source("counter.tsx");
    expect(await findEnclosingSymbol("tsx", tsx, lineOf(tsx, "onClick"))).toMatchObject({
      kind: "function_declaration",
      name: "Counter",
      startLine: 7,
      endLine: 10,
    });
    expect(await findEnclosingSymbol("tsx", tsx, lineOf(tsx, "className"))).toMatchObject({ kind: "arrow_function", name: "Badge" });
    expect(await findEnclosingSymbol("tsx", tsx, lineOf(tsx, "label: string"))).toMatchObject({
      kind: "interface_declaration",
      name: "Props",
    });
  });

  it("javascript (jsx): method, function expression and CommonJS assignment", async () => {
    const js = source("legacy.jsx");
    expect(await findEnclosingSymbol("javascript", js, lineOf(js, "this.store"))).toMatchObject({
      kind: "method_definition",
      name: "Cache.get",
      startLine: 4,
      endLine: 6,
    });
    expect(await findEnclosingSymbol("javascript", js, lineOf(js, "<li>"))).toMatchObject({
      kind: "function_expression",
      name: "render",
      startLine: 9,
      endLine: 11,
    });
    expect(await findEnclosingSymbol("javascript", js, lineOf(js, "path.sep"))).toMatchObject({ name: "exports.helper" });
  });

  it("python: def in a class, with the decorator in range", async () => {
    const py = source("svc.py");
    expect(await findEnclosingSymbol("python", py, lineOf(py, "User.get"))).toMatchObject({
      kind: "function_definition",
      name: "UserService.find",
      startLine: 16,
      endLine: 18,
    });
    expect(await findEnclosingSymbol("python", py, lineOf(py, "j.load"))).toMatchObject({ name: "load", startLine: 7, endLine: 9 });
    expect(await findEnclosingSymbol("python", py, lineOf(py, "self.repo"))).toMatchObject({ name: "UserService.__init__" });
  });

  it("go: method with receiver type, function and type", async () => {
    const go = source("server.go");
    const handle = await findEnclosingSymbol("go", go, lineOf(go, "fmt.Errorf"));
    expect(handle).toMatchObject({ kind: "method_declaration", name: "Server.Handle", startLine: 16, endLine: 19 });
    expect(handle?.body.startsWith("func (s *Server) Handle")).toBe(true);
    expect(await findEnclosingSymbol("go", go, lineOf(go, "return &Server"))).toMatchObject({ kind: "function_declaration", name: "New" });
    expect(await findEnclosingSymbol("go", go, lineOf(go, "addr string"))).toMatchObject({
      kind: "type_declaration",
      name: "Server",
      startLine: 8,
      endLine: 10,
    });
  });

  it("analyzeSource falls back to later candidate lines", async () => {
    const { symbols } = await analyzeSource("typescript", ts, [[5, 15], [4], []]);
    expect(symbols[0]?.name).toBe("UserService.find");
    expect(symbols[1]).toBeUndefined();
    expect(symbols[2]).toBeUndefined();
  });
});

describe("imports and exports", () => {
  it("typescript", async () => {
    const a = await analyzeSource("typescript", source("user-service.ts"));
    expect(a.imports).toEqual(["../types.js", "./db.js", "node:crypto"]);
    expect(a.exports).toEqual(["MAX_USERS", "UserService", "database", "default", "formatUser", "hashPassword"]);
    expect(a.topLevelSymbols).toEqual([
      "MAX_USERS",
      "UserService",
      "UserService.constructor",
      "UserService.find",
      "UserService.normalize",
      "formatUser",
      "hashPassword",
    ]);
  });

  it("typescript re-exports, namespace exports, require and dynamic import", async () => {
    const src = [
      'import a, { b as c } from "./x";',
      'export { q as r } from "./re";',
      'export * from "./all";',
      'export * as ns from "./ns";',
      "export type T = string;",
      "export interface I { a: string }",
      "export enum E { A }",
      'const cjs = require("cjs");',
      'const lazy = () => import("./lazy");',
    ].join("\n");
    const a = await analyzeSource("typescript", src);
    expect(a.imports).toEqual(["./all", "./lazy", "./ns", "./re", "./x", "cjs"]);
    expect(a.exports).toEqual(["*", "E", "I", "T", "ns", "r"]);
  });

  it("tsx", async () => {
    const a = await analyzeSource("tsx", source("counter.tsx"));
    expect(a.imports).toEqual(["react"]);
    expect(a.exports).toEqual(["Badge", "Counter"]);
  });

  it("javascript (CommonJS)", async () => {
    const a = await analyzeSource("javascript", source("legacy.jsx"));
    expect(a.imports).toEqual(["node:path"]);
    expect(a.exports).toEqual(["default", "helper"]);
    expect(a.topLevelSymbols).toEqual(["Cache", "Cache.get", "path", "render"]);
  });

  it("python: import modules; public defs/classes as exports", async () => {
    const a = await analyzeSource("python", source("svc.py"));
    expect(a.imports).toEqual([".", ".models", "json", "os"]);
    expect(a.exports).toEqual(["UserService", "load"]);
    expect(a.topLevelSymbols).toEqual(["UserService", "UserService.__init__", "UserService.find", "_private", "load"]);
  });

  it("python: __all__ wins over the public-name rule", async () => {
    const a = await analyzeSource("python", '__all__ = ["load", \'Thing\']\n\ndef load():\n    pass\n\ndef other():\n    pass\n');
    expect(a.exports).toEqual(["Thing", "load"]);
  });

  it("go: import paths and exported (uppercase) identifiers", async () => {
    const a = await analyzeSource("go", source("server.go"));
    expect(a.imports).toEqual(["fmt", "github.com/sirupsen/logrus"]);
    expect(a.exports).toEqual(["MaxConns", "New", "Server", "Server.Handle"]);
    expect(a.topLevelSymbols).toEqual(["New", "Server", "Server.Handle", "helper"]);
  });
});
