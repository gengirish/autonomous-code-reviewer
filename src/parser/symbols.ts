/**
 * Facts read from the parsed HEAD version of a file: the enclosing symbol of a RIGHT line,
 * imports, exports and top-level symbols (repo map).
 *
 * Symbol node types (acr-parser, extended):
 *   TS/JS  function_declaration, generator_function_declaration, method_definition,
 *          class_declaration, abstract_class_declaration, interface_declaration,
 *          type_alias_declaration, enum_declaration, and arrow_function / function_expression
 *          whose parent is a variable_declarator (declarator name), a class field
 *          (`Class.field`) or an assignment (`exports.x = function …`).
 *          Methods are class-qualified: `UserService.find`.
 *   Python function_definition, class_definition (class-qualified: `Svc.method`; a
 *          decorated_definition wrapper is included in the range).
 *   Go     function_declaration, method_declaration (`Server.Handle`), type_declaration.
 */
import type { Node } from "web-tree-sitter";
import type { SymbolInfo } from "../schemas/review-context.js";
import type { LanguageId } from "./languages.js";
import { withTree } from "./treesitter.js";

export interface FileAnalysis {
  /** One entry per requested line group: the symbol around the first line that has one. */
  symbols: Array<SymbolInfo | undefined>;
  imports: string[];
  exports: string[];
  /** Top-level symbol names (classes include `Class.method` entries). */
  topLevelSymbols: string[];
}

interface Found {
  kind: string;
  name: string;
  range: Node;
}

const isJsLike = (lang: LanguageId): boolean => lang === "typescript" || lang === "tsx" || lang === "javascript";

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const nameOf = (node: Node | null | undefined): string | null => node?.childForFieldName("name")?.text ?? null;

function stringValue(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "string" || node.type === "interpreted_string_literal" || node.type === "raw_string_literal") {
    return node.text.slice(1, -1);
  }
  return null;
}

// ───────────────────────────── enclosing symbol ─────────────────────────────

const JS_CLASS_TYPES = new Set(["class_declaration", "abstract_class_declaration", "class"]);
const JS_FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

/** Name of the class that contains `node` (TS/JS), or null. */
function jsClassName(node: Node): string | null {
  for (let p = node.parent; p; p = p.parent) {
    if (JS_CLASS_TYPES.has(p.type)) {
      const own = nameOf(p);
      if (own) return own;
      // `const Foo = class { … }`
      return p.parent?.type === "variable_declarator" ? nameOf(p.parent) : null;
    }
  }
  return null;
}

function describeJs(node: Node): Found | null {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "class_declaration":
    case "abstract_class_declaration":
    case "interface_declaration":
    case "type_alias_declaration":
    case "enum_declaration": {
      const name = nameOf(node);
      return name ? { kind: node.type, name, range: node } : null;
    }
    case "method_definition": {
      const name = nameOf(node);
      if (!name) return null;
      const cls = jsClassName(node);
      return { kind: node.type, name: cls ? `${cls}.${name}` : name, range: node };
    }
    default:
      break;
  }
  if (!JS_FUNCTION_VALUES.has(node.type)) return null;
  const parent = node.parent;
  if (!parent) return null;
  if (parent.type === "variable_declarator") {
    const name = nameOf(parent);
    if (!name) return null;
    const decl = parent.parent;
    // Include `const x =` (the whole declaration) when it declares only this one variable.
    const range = decl && decl.namedChildren.filter((c) => c.type === "variable_declarator").length === 1 ? decl : parent;
    return { kind: node.type, name, range };
  }
  if (parent.type === "public_field_definition" || parent.type === "field_definition") {
    const name = parent.childForFieldName("name")?.text ?? parent.childForFieldName("property")?.text;
    if (!name) return null;
    const cls = jsClassName(parent);
    return { kind: node.type, name: cls ? `${cls}.${name}` : name, range: parent };
  }
  if (parent.type === "assignment_expression") {
    const left = parent.childForFieldName("left");
    if (!left) return null;
    const range = parent.parent?.type === "expression_statement" ? parent.parent : parent;
    return { kind: node.type, name: left.text, range };
  }
  return null;
}

function describePython(node: Node): Found | null {
  if (node.type !== "function_definition" && node.type !== "class_definition") return null;
  const own = nameOf(node);
  if (!own) return null;
  const classes: string[] = [];
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "class_definition") {
      const n = nameOf(p);
      if (n) classes.unshift(n);
    }
  }
  const range = node.parent?.type === "decorated_definition" ? node.parent : node;
  return { kind: node.type, name: [...classes, own].join("."), range };
}

/** `func (s *Server[T]) …` → "Server". */
function goReceiverType(method: Node): string | null {
  const receiver = method.childForFieldName("receiver");
  const param = receiver?.namedChildren.find((c) => c.type === "parameter_declaration");
  let type = param?.childForFieldName("type") ?? null;
  while (type && (type.type === "pointer_type" || type.type === "generic_type" || type.type === "parenthesized_type")) {
    type = type.type === "generic_type" ? type.childForFieldName("type") : (type.namedChildren[0] ?? null);
  }
  return type?.text ?? null;
}

function describeGo(node: Node, row: number): Found | null {
  switch (node.type) {
    case "function_declaration": {
      const name = nameOf(node);
      return name ? { kind: node.type, name, range: node } : null;
    }
    case "method_declaration": {
      const name = nameOf(node);
      if (!name) return null;
      const recv = goReceiverType(node);
      return { kind: node.type, name: recv ? `${recv}.${name}` : name, range: node };
    }
    case "type_declaration": {
      const specs = node.namedChildren.filter((c) => c.type === "type_spec" || c.type === "type_alias");
      const spec = specs.find((s) => s.startPosition.row <= row && row <= s.endPosition.row) ?? specs[0];
      const name = nameOf(spec);
      if (!name || !spec) return null;
      return { kind: node.type, name, range: specs.length === 1 ? node : spec };
    }
    default:
      return null;
  }
}

function describe(node: Node, lang: LanguageId, row: number): Found | null {
  if (isJsLike(lang)) return describeJs(node);
  if (lang === "python") return describePython(node);
  return describeGo(node, row);
}

/**
 * Innermost symbol whose node spans `row`.
 *
 * The skill's recipe is `descendantForPosition(row, col)` + walk `.parent`. That misses
 * one-line symbols whose line starts outside the function node (`export const A = () => …`,
 * `private f = () => …`, `exports.x = () => …`): the point lands on `export`/`private`, whose
 * ancestors don't include the arrow function. So we descend from the root instead, into every
 * child whose row range contains `row`, and keep the deepest symbol found (ties: first).
 * For multi-line bodies this gives the same answer as the parent walk.
 */
function innermostSymbol(root: Node, lang: LanguageId, row: number): Found | null {
  let best: Found | null = null;
  let bestDepth = -1;
  const visit = (node: Node, depth: number) => {
    const found = describe(node, lang, row);
    if (found && depth > bestDepth) {
      best = found;
      bestDepth = depth;
    }
    for (const child of node.namedChildren) {
      if (child.startPosition.row <= row && row <= child.endPosition.row) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return best;
}

function symbolAtRow(root: Node, lang: LanguageId, row: number, srcLines: string[]): SymbolInfo | undefined {
  if (row < 0 || row >= srcLines.length) return undefined;
  const found = innermostSymbol(root, lang, row);
  if (!found) return undefined;
  const startLine = found.range.startPosition.row + 1;
  const endLine = found.range.endPosition.row + 1;
  return {
    kind: found.kind,
    name: found.name,
    startLine,
    endLine,
    body: srcLines.slice(startLine - 1, endLine).join("\n"),
  };
}

// ───────────────────────────── imports / exports / top level ─────────────────────────────

function jsImports(root: Node): string[] {
  const out: string[] = [];
  for (const child of root.namedChildren) {
    if (child.type === "import_statement" || child.type === "export_statement") {
      const src = stringValue(child.childForFieldName("source"));
      if (src !== null) out.push(src);
    }
  }
  // CommonJS require("x") and dynamic import("x") anywhere in the file.
  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call.childForFieldName("function");
    if (!fn || !(fn.type === "import" || (fn.type === "identifier" && fn.text === "require"))) continue;
    const src = stringValue(call.childForFieldName("arguments")?.namedChildren[0]);
    if (src !== null) out.push(src);
  }
  return out;
}

/** Names declared by a TS/JS declaration node (function, class, `const a = …, b = …`). */
function jsDeclaredNames(decl: Node): string[] {
  if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
    return decl.namedChildren.filter((c) => c.type === "variable_declarator").flatMap((d) => {
      const n = d.childForFieldName("name");
      return n && n.type === "identifier" ? [n.text] : [];
    });
  }
  const name = nameOf(decl);
  return name ? [name] : [];
}

function jsExports(root: Node): string[] {
  const out: string[] = [];
  for (const child of root.namedChildren) {
    if (child.type === "export_statement") {
      const isDefault = child.children.some((c) => c.type === "default");
      if (isDefault) {
        out.push("default");
        continue;
      }
      const decl = child.childForFieldName("declaration");
      if (decl) {
        out.push(...jsDeclaredNames(decl));
        continue;
      }
      const clause = child.namedChildren.find((c) => c.type === "export_clause");
      if (clause) {
        for (const spec of clause.namedChildren) {
          if (spec.type !== "export_specifier") continue;
          const n = spec.childForFieldName("alias") ?? spec.childForFieldName("name");
          if (n) out.push(stringValue(n) ?? n.text);
        }
        continue;
      }
      const ns = child.namedChildren.find((c) => c.type === "namespace_export");
      const nsName = ns?.namedChildren[0];
      out.push(nsName ? (stringValue(nsName) ?? nsName.text) : "*");
      continue;
    }
    // CommonJS: module.exports = …, module.exports.x = …, exports.x = …
    if (child.type === "expression_statement") {
      const expr = child.namedChildren[0];
      if (expr?.type !== "assignment_expression") continue;
      const left = expr.childForFieldName("left")?.text ?? "";
      if (left === "module.exports") out.push("default");
      else {
        const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left);
        if (m?.[1]) out.push(m[1]);
      }
    }
  }
  return out;
}

function jsTopLevel(root: Node): string[] {
  const out: string[] = [];
  for (let child of root.namedChildren) {
    if (child.type === "export_statement") {
      const decl = child.childForFieldName("declaration");
      if (!decl) continue;
      child = decl;
    }
    if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
      out.push(...jsDeclaredNames(child));
      continue;
    }
    const name = nameOf(child);
    if (!name) continue;
    if (child.type === "class_declaration" || child.type === "abstract_class_declaration") {
      out.push(name);
      for (const member of child.childForFieldName("body")?.namedChildren ?? []) {
        if (member.type === "method_definition" || member.type === "public_field_definition" || member.type === "field_definition") {
          const m = member.childForFieldName("name")?.text ?? member.childForFieldName("property")?.text;
          if (m) out.push(`${name}.${m}`);
        }
      }
    } else if (
      child.type === "function_declaration" ||
      child.type === "generator_function_declaration" ||
      child.type === "interface_declaration" ||
      child.type === "type_alias_declaration" ||
      child.type === "enum_declaration"
    ) {
      out.push(name);
    }
  }
  return out;
}

function pyImports(root: Node): string[] {
  const out: string[] = [];
  for (const node of root.descendantsOfType(["import_statement", "import_from_statement", "future_import_statement"])) {
    if (node.type === "future_import_statement") out.push("__future__");
    else if (node.type === "import_from_statement") {
      const m = node.childForFieldName("module_name");
      if (m) out.push(m.text);
    } else {
      for (const n of node.childrenForFieldName("name")) {
        out.push(n.type === "aliased_import" ? (n.childForFieldName("name")?.text ?? n.text) : n.text);
      }
    }
  }
  return out;
}

const unwrapPy = (n: Node): Node => (n.type === "decorated_definition" ? (n.childForFieldName("definition") ?? n) : n);

function pyTopLevel(root: Node): string[] {
  const out: string[] = [];
  for (const raw of root.namedChildren) {
    const child = unwrapPy(raw);
    const name = nameOf(child);
    if (!name) continue;
    if (child.type === "function_definition") out.push(name);
    if (child.type === "class_definition") {
      out.push(name);
      for (const m of child.childForFieldName("body")?.namedChildren ?? []) {
        const def = unwrapPy(m);
        const mn = def.type === "function_definition" ? nameOf(def) : null;
        if (mn) out.push(`${name}.${mn}`);
      }
    }
  }
  return out;
}

/** `__all__` when present, else public top-level functions and classes. */
function pyExports(root: Node): string[] {
  for (const stmt of root.namedChildren) {
    const assign = stmt.type === "expression_statement" ? stmt.namedChildren[0] : null;
    if (assign?.type !== "assignment" || assign.childForFieldName("left")?.text !== "__all__") continue;
    const right = assign.childForFieldName("right");
    if (right && (right.type === "list" || right.type === "tuple")) {
      return right.namedChildren.filter((c) => c.type === "string").map((c) => c.namedChildren.find((x) => x.type === "string_content")?.text ?? "");
    }
  }
  return root.namedChildren
    .map(unwrapPy)
    .filter((c) => c.type === "function_definition" || c.type === "class_definition")
    .flatMap((c) => {
      const n = nameOf(c);
      return n && !n.startsWith("_") ? [n] : [];
    });
}

function goImports(root: Node): string[] {
  return root.descendantsOfType("import_spec").flatMap((spec) => {
    const p = stringValue(spec.childForFieldName("path"));
    return p === null ? [] : [p];
  });
}

const isGoExported = (name: string): boolean => /^\p{Lu}/u.test(name);

function goTopLevel(root: Node, exportedOnly: boolean): string[] {
  const out: string[] = [];
  const add = (display: string, ident: string) => {
    if (!exportedOnly || isGoExported(ident)) out.push(display);
  };
  for (const child of root.namedChildren) {
    switch (child.type) {
      case "function_declaration": {
        const n = nameOf(child);
        if (n) add(n, n);
        break;
      }
      case "method_declaration": {
        const n = nameOf(child);
        const recv = goReceiverType(child);
        if (n) add(recv ? `${recv}.${n}` : n, n);
        break;
      }
      case "type_declaration":
        for (const spec of child.namedChildren) {
          const n = nameOf(spec);
          if (n) add(n, n);
        }
        break;
      case "const_declaration":
      case "var_declaration":
        if (!exportedOnly) break; // consts/vars are exports when public, but noise in the repo map
        for (const spec of child.descendantsOfType(["const_spec", "var_spec"])) {
          for (const n of spec.childrenForFieldName("name")) add(n.text, n.text);
        }
        break;
      default:
        break;
    }
  }
  return out;
}

// ───────────────────────────── public API ─────────────────────────────

/**
 * Parses `source` once and answers everything the context builder needs.
 * `lineGroups[i]` lists candidate RIGHT lines (1-based) for hunk i; the symbol is taken
 * from the first candidate that sits inside one.
 */
export async function analyzeSource(lang: LanguageId, source: string, lineGroups: number[][] = []): Promise<FileAnalysis> {
  const srcLines = source.replace(/\r\n/g, "\n").split("\n");
  return withTree(lang, source.replace(/\r\n/g, "\n"), (tree) => {
    const root = tree.rootNode;
    const symbols = lineGroups.map((group) => {
      for (const line of group) {
        const s = symbolAtRow(root, lang, line - 1, srcLines);
        if (s) return s;
      }
      return undefined;
    });
    let imports: string[];
    let exports: string[];
    let topLevel: string[];
    if (isJsLike(lang)) {
      imports = jsImports(root);
      exports = jsExports(root);
      topLevel = jsTopLevel(root);
    } else if (lang === "python") {
      imports = pyImports(root);
      exports = pyExports(root);
      topLevel = pyTopLevel(root);
    } else {
      imports = goImports(root);
      exports = goTopLevel(root, true);
      topLevel = goTopLevel(root, false);
    }
    return { symbols, imports: sortedUnique(imports), exports: sortedUnique(exports), topLevelSymbols: sortedUnique(topLevel) };
  });
}

/** Enclosing symbol of one RIGHT line (1-based), or undefined at top level. */
export async function findEnclosingSymbol(lang: LanguageId, source: string, line: number): Promise<SymbolInfo | undefined> {
  const { symbols } = await analyzeSource(lang, source, [[line]]);
  return symbols[0];
}
