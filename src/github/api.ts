/**
 * Narrow seam over Octokit. Everything in src/github talks to this interface so tests can
 * swap in a fake without mocking modules.
 *
 * Note: `@octokit/app` v16 builds on bare `@octokit/core` (no `.rest.*` methods and no
 * `paginate`), so we use route strings and implement page-based pagination ourselves.
 */
export interface GitHubResponse<T> {
  status: number;
  data: T;
  headers: Record<string, string | undefined>;
}

export interface GitHubApi {
  request<T = unknown>(route: string, params?: Record<string, unknown>): Promise<GitHubResponse<T>>;
  /** Fetches every page of a list endpoint (per_page defaults to 100). */
  paginate<T = unknown>(route: string, params?: Record<string, unknown>): Promise<T[]>;
}

/** Structural shape of the Octokit (core) instance we adapt. */
export interface OctokitLike {
  request(
    route: string,
    params?: Record<string, unknown>,
  ): Promise<{ status: number; data: unknown; headers: Record<string, string | number | undefined> }>;
}

/** Upper bound on pages fetched by `paginate` (the PR files API caps at ~3000 files = 30 pages). */
export const MAX_PAGES = 100;

const hasNextLink = (link: string | undefined): boolean => !!link && /rel="next"/.test(link);

/** Page-number pagination over any `request` function, following the Link header. */
export async function paginateWith<T>(
  request: GitHubApi["request"],
  route: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const perPage = typeof params.per_page === "number" ? params.per_page : 100;
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await request<T[] | unknown>(route, { ...params, per_page: perPage, page });
    if (!Array.isArray(res.data)) {
      throw new Error(`paginate: ${route} did not return an array`);
    }
    out.push(...(res.data as T[]));
    if (!hasNextLink(res.headers.link) || res.data.length === 0) break;
  }
  return out;
}

export function adaptOctokit(octokit: OctokitLike): GitHubApi {
  const request: GitHubApi["request"] = async <T>(route: string, params?: Record<string, unknown>) => {
    const res = await octokit.request(route, params);
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v === undefined ? undefined : String(v);
    return { status: res.status, data: res.data as T, headers };
  };
  return {
    request,
    paginate: <T>(route: string, params?: Record<string, unknown>) => paginateWith<T>(request, route, params),
  };
}

/** HTTP status of an Octokit RequestError (or any error carrying a numeric `status`). */
export function statusOf(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

/** Encodes a repo path for use inside a route, keeping "/" separators. */
export function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** Decodes a base64 payload from the GitHub API (which wraps lines with "\n"). */
export function decodeBase64(content: string): string {
  return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
}
