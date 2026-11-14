import { describe, expect, it } from "vitest";
import { isSkippedPath } from "../../../src/parser/index.js";

describe("isSkippedPath", () => {
  it.each([
    ["package-lock.json", "lockfile"],
    ["web/yarn.lock", "lockfile"],
    ["pnpm-lock.yaml", "lockfile"],
    ["Cargo.lock", "lockfile"],
    ["poetry.lock", "lockfile"],
    ["go.sum", "lockfile"],
    ["dist/index.js", "build output"],
    ["packages/api/build/main.js", "build output"],
    ["vendor/github.com/x/y.go", "vendored"],
    ["node_modules/zod/index.js", "dependency"],
    ["public/app.min.js", "minified"],
    ["styles/site.min.css", "minified"],
    ["dist2/app.js.map", "source map"],
    ["src/__snapshots__/render.test.ts.snap", "snapshot"],
    ["src/api.generated.ts", "generated"],
    ["src/db/generated/client.ts", "generated"],
    ["proto/user.pb.go", "generated"],
    ["assets/logo.PNG", "binary"],
    ["fonts/Inter.woff2", "binary"],
    ["bin/tool.exe", "binary"],
    ["docs/spec.pdf", "binary"],
  ])("%s is skipped (%s)", (path, reason) => {
    expect(isSkippedPath(path)).toMatch(new RegExp(reason, "i"));
  });

  it.each([
    "src/index.ts",
    "src/build-info.ts",
    "src/distance.ts",
    "README.md",
    "package.json",
    "go.mod",
    "src/parser/render.test.ts",
    "lib/vendored-notes.md",
    "app/minify.js",
  ])("%s is reviewed", (path) => {
    expect(isSkippedPath(path)).toBeNull();
  });
});
