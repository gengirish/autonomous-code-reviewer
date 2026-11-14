import { App } from "@octokit/app";
import { NotReviewableError } from "../core/errors.js";
import { adaptOctokit, statusOf, type GitHubApi } from "./api.js";

export interface GitHubAppClient {
  /** Installation-scoped API for a repo. Throws NotReviewableError when the App is not installed. */
  apiFor(owner: string, repo: string): Promise<GitHubApi>;
}

/** Test seam: the app-level (JWT) API plus a way to get an installation-scoped API. */
export interface GitHubAppSeam {
  appApi: GitHubApi;
  installationApi(installationId: number): Promise<GitHubApi>;
}

export function createGitHubAppFromSeam(seam: GitHubAppSeam): GitHubAppClient {
  const installationIds = new Map<string, Promise<number>>();
  const installationApis = new Map<number, Promise<GitHubApi>>();

  const installationIdFor = (owner: string, repo: string): Promise<number> => {
    const key = `${owner}/${repo}`.toLowerCase();
    let pending = installationIds.get(key);
    if (!pending) {
      pending = seam.appApi
        .request<{ id: number }>("GET /repos/{owner}/{repo}/installation", { owner, repo })
        .then(
          (res) => res.data.id,
          (err: unknown) => {
            if (statusOf(err) === 404) {
              throw new NotReviewableError(`GitHub App not installed on ${owner}/${repo}`, { cause: err });
            }
            throw err;
          },
        );
      // Don't cache failures: the App may be installed later, or the error may be transient.
      const self = pending;
      self.catch(() => {
        if (installationIds.get(key) === self) installationIds.delete(key);
      });
      installationIds.set(key, self);
    }
    return pending;
  };

  const apiForInstallation = (id: number): Promise<GitHubApi> => {
    let pending = installationApis.get(id);
    if (!pending) {
      pending = seam.installationApi(id);
      const self = pending;
      self.catch(() => {
        if (installationApis.get(id) === self) installationApis.delete(id);
      });
      installationApis.set(id, self);
    }
    return pending;
  };

  return {
    async apiFor(owner, repo) {
      return apiForInstallation(await installationIdFor(owner, repo));
    },
  };
}

/** Real GitHub App client. Installation tokens are cached and refreshed by Octokit. */
export function createGitHubApp(opts: { appId: string | number; privateKey: string }): GitHubAppClient {
  const app = new App({ appId: opts.appId, privateKey: opts.privateKey });
  return createGitHubAppFromSeam({
    appApi: adaptOctokit(app.octokit),
    installationApi: async (id) => adaptOctokit(await app.getInstallationOctokit(id)),
  });
}
