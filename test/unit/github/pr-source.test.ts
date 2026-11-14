import { describe, expect, it } from "vitest";
import { adaptOctokit, type OctokitLike } from "../../../src/github/api.js";
import { createGitHubPrSource } from "../../../src/github/pr-source.js";
import type { PrFile } from "../../../src/core/ports.js";
import { b64, FakeGitHubApi, FakeRequestError, nextLink, respond } from "./fake-api.js";

const ref = { owner: "octo", repo: "demo", pr: 7 };
const PULL = "GET /repos/{owner}/{repo}/pulls/{pull_number}";
const FILES = "GET /repos/{owner}/{repo}/pulls/{pull_number}/files";
const BLOB = "GET /repos/{owner}/{repo}/git/blobs/{file_sha}";

const apiFile = (n: number) => ({ filename: `f${n}.ts`, status: "modified", sha: `sha${n}`, additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b" });

describe("GitHub PrSource", () => {
  it("maps the pull request to PrMeta (null body, closed state)", async () => {
    const api = new FakeGitHubApi().on(PULL, () => ({
      head: { sha: "h".repeat(40) },
      base: { sha: "b".repeat(40) },
      title: "Add thing",
      body: null,
      draft: true,
      state: "closed",
      merged: true,
    }));
    const meta = await createGitHubPrSource(api).getPr(ref);
    expect(meta).toEqual({ headSha: "h".repeat(40), baseSha: "b".repeat(40), title: "Add thing", body: "", draft: true, state: "closed" });
    expect(api.calls[0]?.params).toEqual({ owner: "octo", repo: "demo", pull_number: 7 });
  });

  it("maps files, including a missing patch and a rename", async () => {
    const api = new FakeGitHubApi().on(FILES, () => [
      { filename: "img.png", status: "added", sha: "s1", additions: 0, deletions: 0 },
      { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed", sha: "s2", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@" },
    ]);
    const files = await createGitHubPrSource(api).listFiles(ref);
    expect(files).toEqual<PrFile[]>([
      { path: "img.png", status: "added", blobSha: "s1", additions: 0, deletions: 0 },
      { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed", blobSha: "s2", additions: 2, deletions: 1, patch: "@@ -1 +1,2 @@" },
    ]);
    expect(files[0]).not.toHaveProperty("patch");
    expect(api.calls[0]?.params).toMatchObject({ pull_number: 7, per_page: 100, page: 1 });
  });

  it("paginates files while the Link header has rel=next", async () => {
    const api = new FakeGitHubApi().on(FILES, (p) => {
      const page = p.page as number;
      const items = Array.from({ length: page < 3 ? 100 : 5 }, (_, i) => apiFile((page - 1) * 100 + i));
      return respond(items, page < 3 ? { link: nextLink(page + 1) } : {});
    });
    const files = await createGitHubPrSource(api).listFiles(ref);
    expect(files).toHaveLength(205);
    expect(api.calls.map((c) => c.params.page)).toEqual([1, 2, 3]);
  });

  it("decodes base64 blobs with embedded newlines", async () => {
    const text = "export const π = 3.14;\n".repeat(20);
    const api = new FakeGitHubApi().on(BLOB, () => ({ content: b64(text), encoding: "base64", sha: "s1" }));
    const file: PrFile = { path: "a.ts", status: "modified", blobSha: "s1", additions: 1, deletions: 0 };
    await expect(createGitHubPrSource(api).getContent(ref, file)).resolves.toBe(text);
    expect(api.calls[0]?.params).toEqual({ owner: "octo", repo: "demo", file_sha: "s1" });
  });

  describe("getRepoFile", () => {
    it("fetches at the given ref and decodes, keeping '/' in the path", async () => {
      const route = "GET /repos/{owner}/{repo}/contents/config/eslint.config.js";
      const api = new FakeGitHubApi().on(route, () => ({ type: "file", content: b64("export default [];"), encoding: "base64", sha: "x" }));
      const out = await createGitHubPrSource(api).getRepoFile!(ref, "config/eslint.config.js", "abc123");
      expect(out).toBe("export default [];");
      expect(api.calls[0]).toEqual({ route, params: { owner: "octo", repo: "demo", ref: "abc123" } });
    });

    it("returns null on 404", async () => {
      const api = new FakeGitHubApi().on("GET /repos/{owner}/{repo}/contents/.eslintrc.json", () => {
        throw new FakeRequestError(404, "Not Found");
      });
      await expect(createGitHubPrSource(api).getRepoFile!(ref, ".eslintrc.json", "abc")).resolves.toBeNull();
    });

    it("returns null for a directory and propagates other errors", async () => {
      const api = new FakeGitHubApi()
        .on("GET /repos/{owner}/{repo}/contents/src", () => [{ type: "file" }])
        .on("GET /repos/{owner}/{repo}/contents/ruff.toml", () => {
          throw new FakeRequestError(500);
        });
      const src = createGitHubPrSource(api);
      await expect(src.getRepoFile!(ref, "src", "abc")).resolves.toBeNull();
      await expect(src.getRepoFile!(ref, "ruff.toml", "abc")).rejects.toMatchObject({ status: 500 });
    });

    it("falls back to the blob API for files over 1 MB (encoding none)", async () => {
      const api = new FakeGitHubApi()
        .on("GET /repos/{owner}/{repo}/contents/big.json", () => ({ type: "file", content: "", encoding: "none", sha: "bigsha" }))
        .on(BLOB, () => ({ content: b64("{}"), encoding: "base64" }));
      await expect(createGitHubPrSource(api).getRepoFile!(ref, "big.json", "abc")).resolves.toBe("{}");
      expect(api.callsTo(BLOB)[0]?.params.file_sha).toBe("bigsha");
    });
  });
});

describe("adaptOctokit", () => {
  it("normalises headers and paginates via request()", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const octokit: OctokitLike = {
      async request(_route, params) {
        seen.push(params);
        const page = params?.page as number;
        return { status: 200, data: [page], headers: page === 1 ? { Link: nextLink(2), "X-RateLimit-Remaining": 42 } : {} };
      },
    };
    const api = adaptOctokit(octokit);
    const first = await api.request("GET /x", { page: 1 });
    expect(first.headers["x-ratelimit-remaining"]).toBe("42");
    await expect(api.paginate("GET /x")).resolves.toEqual([1, 2]);
    expect(seen.slice(1)).toEqual([{ per_page: 100, page: 1 }, { per_page: 100, page: 2 }]);
  });
});
