import type { PrFile, PrMeta, PrSource } from "../core/ports.js";
import type { PrRef } from "../schemas/index.js";
import { decodeBase64, encodePath, statusOf, type GitHubApi } from "./api.js";

interface PullResponse {
  head: { sha: string };
  base: { sha: string };
  title: string;
  body: string | null;
  draft?: boolean;
  state: string;
}

interface PullFileResponse {
  filename: string;
  previous_filename?: string;
  status: PrFile["status"];
  patch?: string;
  sha: string;
  additions: number;
  deletions: number;
}

interface BlobResponse {
  content: string;
  encoding: string;
}

interface ContentsResponse {
  type?: string;
  sha?: string;
  content?: string;
  encoding?: string;
}

const repoParams = (ref: PrRef) => ({ owner: ref.owner, repo: ref.repo });

export function toPrFile(f: PullFileResponse): PrFile {
  const file: PrFile = {
    path: f.filename,
    status: f.status,
    blobSha: f.sha,
    additions: f.additions,
    deletions: f.deletions,
  };
  if (f.previous_filename !== undefined) file.previousPath = f.previous_filename;
  if (f.patch !== undefined) file.patch = f.patch;
  return file;
}

function decodeEncoded(content: string, encoding: string): string {
  return encoding === "base64" ? decodeBase64(content) : content;
}

export function createGitHubPrSource(api: GitHubApi): PrSource {
  const getBlob = async (ref: PrRef, sha: string): Promise<string> => {
    const { data } = await api.request<BlobResponse>("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
      ...repoParams(ref),
      file_sha: sha,
    });
    return decodeEncoded(data.content, data.encoding);
  };

  return {
    async getPr(ref) {
      const { data } = await api.request<PullResponse>("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        ...repoParams(ref),
        pull_number: ref.pr,
      });
      const meta: PrMeta = {
        headSha: data.head.sha,
        baseSha: data.base.sha,
        title: data.title,
        body: data.body ?? "",
        draft: data.draft ?? false,
        state: data.state === "open" ? "open" : "closed",
      };
      return meta;
    },

    async listFiles(ref) {
      const files = await api.paginate<PullFileResponse>("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
        ...repoParams(ref),
        pull_number: ref.pr,
        per_page: 100,
      });
      return files.map(toPrFile);
    },

    async getContent(ref, file) {
      return getBlob(ref, file.blobSha);
    },

    async getRepoFile(ref, path, sha) {
      try {
        // Path is pre-encoded per segment so "/" stays a separator (Octokit would encode it as %2F).
        const { data } = await api.request<ContentsResponse | ContentsResponse[]>(
          `GET /repos/{owner}/{repo}/contents/${encodePath(path)}`,
          { ...repoParams(ref), ref: sha },
        );
        if (Array.isArray(data) || (data.type !== undefined && data.type !== "file")) return null;
        // Files over 1 MB come back with encoding "none" and no content: fall back to the blob API.
        if (data.encoding === "none" || data.content === undefined || data.content === "") {
          return data.sha ? await getBlob(ref, data.sha) : "";
        }
        return decodeEncoded(data.content, data.encoding ?? "base64");
      } catch (err) {
        if (statusOf(err) === 404) return null;
        throw err;
      }
    },
  };
}
