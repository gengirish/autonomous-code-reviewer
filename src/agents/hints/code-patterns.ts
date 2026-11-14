import type { AddedLine } from "./util.js";

export interface PatternHit {
  file: string;
  line: number;
  kind: string;
}

interface Pattern {
  kind: string;
  re: RegExp;
}

/** Sinks worth a second look when their input is not a constant. */
const DANGEROUS_APIS: readonly Pattern[] = [
  { kind: "eval()", re: /(?<![\w$.])eval\s*\(/ },
  { kind: "new Function()", re: /\bnew\s+Function\s*\(/ },
  { kind: "vm code execution", re: /\bvm\.(?:runIn\w*Context|runInThisContext|compileFunction)\s*\(|\bnew\s+vm\.Script\s*\(/ },
  { kind: "child_process exec with a template literal", re: /\bexec(?:Sync)?\s*\(\s*`[^`]*\$\{/ },
  { kind: "child_process exec with string concatenation", re: /\bexec(?:Sync)?\s*\(\s*(?:["'][^"']*["']\s*\+|\w+\s*\+)/ },
  { kind: "spawn with shell: true", re: /\b(?:spawn|execFile)(?:Sync)?\s*\(.*\bshell\s*:\s*true/ },
  { kind: "os.system / subprocess with shell=True", re: /\bos\.(?:system|popen)\s*\(|\bsubprocess\.\w+\s*\(.*\bshell\s*=\s*True/ },
  { kind: "exec() with a non-constant argument", re: /(?<![\w$.])exec\s*\(\s*(?!["'][^"']*["']\s*[,)])(?=\S)(?!\))/ },
  { kind: "unsafe deserialisation", re: /\bpickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?(?:Safe|CSafe)Loader)|\bunserialize\s*\(|\bMarshal\.load\b/ },
  { kind: "raw HTML sink", re: /\.innerHTML\s*=|\.outerHTML\s*=|dangerouslySetInnerHTML|\bdocument\.write\s*\(|\.insertAdjacentHTML\s*\(/ },
  { kind: "TLS verification disabled", re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|\bverify\s*=\s*False\b|InsecureSkipVerify\s*:\s*true/ },
  { kind: "weak hash", re: /createHash\s*\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\s*\(/i },
  { kind: "deprecated cipher API / ECB mode", re: /\bcreateCipher\s*\(|\bcreateDecipher\s*\(|-ecb["']|\bMODE_ECB\b/i },
];

const SQL_WORDS = String.raw`\b(?:SELECT\s[\s\S]*\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|WHERE\s+[\w.]+\s*(?:=|<|>|!=|\bIN\b|\bLIKE\b|\bIS\b)|ORDER\s+BY\s|DROP\s+TABLE\b)`;

/**
 * SQL assembled from strings. Tagged templates (sql`…${x}`, Prisma.sql`…`) are parameterised,
 * so a template literal only counts when the backtick is not preceded by an identifier.
 */
const SQL_BUILDING: readonly Pattern[] = [
  { kind: "SQL built with a template literal", re: new RegExp(String.raw`(?:^|[^\w$.\]\)])\x60[^\x60]*${SQL_WORDS}[^\x60]*\$\{`, "i") },
  { kind: "SQL built by string concatenation", re: new RegExp(String.raw`["'][^"']*${SQL_WORDS}[^"']*["']\s*\+\s*[\w$(]`, "i") },
  { kind: "SQL built by string concatenation", re: new RegExp(String.raw`\+\s*["'][^"']*${SQL_WORDS}`, "i") },
  { kind: "SQL built with an f-string / format", re: new RegExp(String.raw`\bf["'][^"']*${SQL_WORDS}[^"']*\{|["'][^"']*${SQL_WORDS}[^"']*["']\s*(?:%\s*[\w(]|\.format\s*\()`, "i") },
];

function scan(lines: readonly AddedLine[], patterns: readonly Pattern[]): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const l of lines) {
    const p = patterns.find((x) => x.re.test(l.text));
    if (p) hits.push({ file: l.file, line: l.line, kind: p.kind });
  }
  return hits;
}

export const scanDangerousApis = (lines: readonly AddedLine[]): PatternHit[] => scan(lines, DANGEROUS_APIS);
export const scanSqlBuilding = (lines: readonly AddedLine[]): PatternHit[] => scan(lines, SQL_BUILDING);

/** Phrases that address an automated reviewer. Scanned in added lines and in the PR title/description. */
const INJECTION =
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your|system)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules?|guidelines?)\b|\b(?:ai|llm|automated|bot)\s+(?:code\s+)?reviewers?\b|\byou\s+are\s+now\b|\b(?:approve|lgtm)\s+(?:this|the)\s+(?:pr|pull\s+request|change)|\breport\s+no\s+(?:issues|findings|problems)\b|\b(?:reveal|print|output)\s+(?:your|the)\s+system\s+prompt\b/i;

export const looksLikeInjection = (text: string): boolean => INJECTION.test(text);
