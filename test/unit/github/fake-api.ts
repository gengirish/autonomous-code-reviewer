import { paginateWith, type GitHubApi, type GitHubResponse } from "../../../src/github/api.js";

export interface RecordedCall {
  route: string;
  params: Record<string, unknown>;
}

/** Shape of Octokit's RequestError that our code relies on (`status`, optional `response.data`). */
export class FakeRequestError extends Error {
  override name = "HttpError";
  constructor(
    readonly status: number,
    message = `HTTP ${status}`,
    readonly response?: { data: unknown },
  ) {
    super(message);
  }
}

type Handler = (params: Record<string, unknown>, call: number) => unknown;

/**
 * Fake GitHubApi: routes map to scripted handlers. A handler may return
 * `{ data, headers? }` via `respond`, plain data, or throw (e.g. FakeRequestError).
 */
export class FakeGitHubApi implements GitHubApi {
  readonly calls: RecordedCall[] = [];
  private readonly handlers = new Map<string, Handler>();

  on(route: string, handler: Handler): this {
    this.handlers.set(route, handler);
    return this;
  }

  callsTo(route: string): RecordedCall[] {
    return this.calls.filter((c) => c.route === route);
  }

  async request<T = unknown>(route: string, params: Record<string, unknown> = {}): Promise<GitHubResponse<T>> {
    const call = this.calls.filter((c) => c.route === route).length;
    this.calls.push({ route, params: structuredClone(params) });
    const handler = this.handlers.get(route);
    if (!handler) throw new Error(`FakeGitHubApi: no handler for ${route}`);
    const out = handler(params, call);
    if (isResponse(out)) return { status: out.status ?? 200, data: out.data as T, headers: out.headers ?? {} };
    return { status: 200, data: out as T, headers: {} };
  }

  paginate<T = unknown>(route: string, params?: Record<string, unknown>): Promise<T[]> {
    return paginateWith<T>((r, p) => this.request(r, p), route, params);
  }
}

const RESPONSE = Symbol("response");
interface ScriptedResponse {
  [RESPONSE]: true;
  status?: number;
  data: unknown;
  headers?: Record<string, string | undefined>;
}
export const respond = (data: unknown, headers?: Record<string, string | undefined>): ScriptedResponse => ({
  [RESPONSE]: true,
  data,
  headers,
});
const isResponse = (x: unknown): x is ScriptedResponse => typeof x === "object" && x !== null && RESPONSE in x;

/** Link header GitHub sends when another page exists. */
export const nextLink = (page: number) => `<https://api.github.com/x?page=${page}>; rel="next"`;

export const b64 = (s: string, wrap = 60) =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(new RegExp(`(.{${wrap}})`, "g"), "$1\n");
