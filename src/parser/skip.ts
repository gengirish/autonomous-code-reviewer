/** Paths not worth reviewing: lockfiles, build output, vendored code, minified/generated files, binaries. */
import type { IsSkippedPath } from "../core/ports.js";
import { extensionOf } from "./languages.js";

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
]);

/** Directory segment → reason. Matched against any segment of the path. */
const SKIPPED_DIRS: ReadonlyArray<[string, string]> = [
  ["node_modules", "dependency directory (node_modules/)"],
  ["vendor", "vendored code (vendor/)"],
  ["dist", "build output (dist/)"],
  ["build", "build output (build/)"],
  ["__snapshots__", "test snapshot (__snapshots__/)"],
  ["generated", "generated code (generated/)"],
  ["__generated__", "generated code (__generated__/)"],
];

const BINARY_EXTENSIONS = new Set([
  // images
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".avif", ".tif", ".tiff", ".psd", ".heic",
  // fonts
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  // archives / binaries / media / documents
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar", ".jar", ".war",
  ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".obj", ".bin", ".class", ".pyc", ".wasm",
  ".mp3", ".mp4", ".mov", ".avi", ".wav", ".ogg", ".webm", ".flac",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".sqlite", ".db",
]);

export const isSkippedPath: IsSkippedPath = (path) => {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const base = (segments[segments.length - 1] ?? "").toLowerCase();

  if (LOCKFILES.has(base)) return `lockfile (${base})`;

  const dirs = segments.slice(0, -1);
  for (const [dir, reason] of SKIPPED_DIRS) {
    if (dirs.includes(dir)) return reason;
  }

  if (/\.min\.(js|css|mjs)$/.test(base)) return "minified file";
  if (base.endsWith(".map")) return "source map";
  if (base.endsWith(".snap")) return "test snapshot (.snap)";
  if (/[.-]generated\./.test(base) || base.includes(".pb.") || base.endsWith("_pb2.py") || base.endsWith(".g.dart")) {
    return "generated file";
  }

  const ext = extensionOf(base);
  if (BINARY_EXTENSIONS.has(ext)) return `binary file (${ext})`;
  return null;
};
