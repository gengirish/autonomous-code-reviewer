import { describe, expect, it } from "vitest";
import { NotReviewableError } from "../../../src/core/errors.js";
import { createGitHubAppFromSeam, type GitHubAppSeam } from "../../../src/github/app-auth.js";
import { createGitHubFactories } from "../../../src/github/index.js";
import type { GitHubApi } from "../../../src/github/api.js";
import { FakeGitHubApi, FakeRequestError } from "./fake-api.js";

const INSTALLATION = "GET /repos/{owner}/{repo}/installation";

function seam(installations: Record<string, number>) {
  const appApi = new FakeGitHubApi().on(INSTALLATION, (p) => {
    const id = installations[`${String(p.owner)}/${String(p.repo)}`];
    if (id === undefined) throw new FakeRequestError(404, "Not Found");
    return { id };
  });
  const created: number[] = [];
  const apis = new Map<number, GitHubApi>();
  const s: GitHubAppSeam = {
    appApi,
    async installationApi(id) {
      created.push(id);
      const api = new FakeGitHubApi();
      apis.set(id, api);
      return api;
    },
  };
  return { s, appApi, created, apis };
}

describe("GitHub App auth", () => {
  it("looks up the installation once per repo and reuses the installation API", async () => {
    const { s, appApi, created, apis } = seam({ "octo/demo": 11, "octo/other": 11, "acme/web": 22 });
    const app = createGitHubAppFromSeam(s);

    const a = await app.apiFor("octo", "demo");
    const b = await app.apiFor("octo", "demo");
    const c = await app.apiFor("octo", "other");
    const d = await app.apiFor("acme", "web");

    expect(a).toBe(b);
    expect(c).toBe(a); // same installation
    expect(d).toBe(apis.get(22));
    expect(appApi.calls.map((x) => x.params)).toEqual([
      { owner: "octo", repo: "demo" },
      { owner: "octo", repo: "other" },
      { owner: "acme", repo: "web" },
    ]);
    expect(created).toEqual([11, 22]);
  });

  it("dedupes concurrent lookups", async () => {
    const { s, appApi } = seam({ "octo/demo": 11 });
    const app = createGitHubAppFromSeam(s);
    await Promise.all([app.apiFor("octo", "demo"), app.apiFor("octo", "demo"), app.apiFor("Octo", "Demo")]);
    expect(appApi.calls).toHaveLength(1);
  });

  it("maps 404 to NotReviewableError and does not cache the failure", async () => {
    const installations: Record<string, number> = {};
    const { s, appApi } = seam(installations);
    const app = createGitHubAppFromSeam(s);

    const err = await app.apiFor("octo", "demo").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotReviewableError);
    expect((err as Error).message).toBe("GitHub App not installed on octo/demo");

    installations["octo/demo"] = 5; // installed later
    await expect(app.apiFor("octo", "demo")).resolves.toBeDefined();
    expect(appApi.calls).toHaveLength(2);
  });

  it("propagates non-404 errors as retryable", async () => {
    const appApi = new FakeGitHubApi().on(INSTALLATION, () => {
      throw new FakeRequestError(500);
    });
    const app = createGitHubAppFromSeam({ appApi, installationApi: async () => new FakeGitHubApi() });
    const err = await app.apiFor("octo", "demo").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NotReviewableError);
    expect(err).toMatchObject({ status: 500 });
  });

  it("factories build a PrSource and publisher on the installation API", async () => {
    const { s, apis } = seam({ "octo/demo": 11 });
    const factories = createGitHubFactories(createGitHubAppFromSeam(s));
    const ref = { owner: "octo", repo: "demo", pr: 3 };
    const source = await factories.prSourceFor(ref);
    const publisher = await factories.publisherFor(ref);

    const api = apis.get(11) as FakeGitHubApi;
    api.on("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", () => []);
    api.on("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", () => []);
    await expect(source.listFiles(ref)).resolves.toEqual([]);
    await expect(publisher.findExistingReview(ref, "a".repeat(40))).resolves.toBeNull();
    expect(api.calls.map((c) => c.params.pull_number)).toEqual([3, 3]);
  });
});
