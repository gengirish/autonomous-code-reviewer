import type { AddedLine } from "./util.js";

export interface SecretHit {
  file: string;
  line: number;
  kind: string;
}

/** Well-known credential formats. Patterns, not values, end up in hints. */
const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "AWS access key ID", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { kind: "AWS secret access key", re: /aws.{0,20}(?:secret|private).{0,20}[:=]\s*["'`]?[A-Za-z0-9/+]{40}\b/i },
  { kind: "GCP API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "GCP service-account key", re: /"type"\s*:\s*"service_account"/ },
  { kind: "private key block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { kind: "Slack token", re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { kind: "Stripe live key", re: /\b[rs]k_live_[0-9A-Za-z]{20,}\b/ },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "OpenAI-style API key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { kind: "credentials in URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:[^\s:/@"'`]{6,}@[^\s"'`]+/i },
];

/** `password = "…"`, `apiKey: '…'`, `SECRET_TOKEN="…"` with a literal value. */
const ASSIGNED_SECRET =
  /\b[\w-]*(?:secret|passw(?:or)?d|passwd|token|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)[\w-]*["']?\s*[:=]\s*["'`]([^"'`\s]{16,})["'`]/i;

const PLACEHOLDER = /^(?:x+|\*+|<.*>|\$\{.*\}|\{\{.*\}\}|%.*%|changeme|change[_-]?me|example|placeholder|dummy|fake|test|redacted|your[_-].*|.*\.\.\..*)$/i;

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function scanSecrets(lines: readonly AddedLine[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const l of lines) {
    const known = SECRET_PATTERNS.find((p) => p.re.test(l.text));
    if (known) {
      hits.push({ file: l.file, line: l.line, kind: known.kind });
      continue;
    }
    const m = ASSIGNED_SECRET.exec(l.text);
    const value = m?.[1];
    if (value && !PLACEHOLDER.test(value) && entropy(value) >= 3.5) {
      hits.push({ file: l.file, line: l.line, kind: "high-entropy literal assigned to a secret-like name" });
    }
  }
  return hits;
}
