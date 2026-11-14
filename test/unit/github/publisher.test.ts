import { pino } from "pino";
import { describe, expect, it } from "vitest";
import type { ReviewPayload } from "../../../src/core/ports.js";
import { isPermanent } from "../../../src/core/errors.js";
import { findLastMarker, parseMarker, reviewMarker } from "../../../src/github/marker.js";
import { capBody, createGitHubPublisher, MAX_BODY_CHARS } from "../../../src/github/publisher.js";
import { FakeGitHubApi, FakeRequestError, nextLink, respond } from "./fake-api.js";

const ref = { owner: "octo", repo: "demo", pr: 7 };
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const REVIEWS = "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
const CREATE = "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
const MARKER = reviewMarker("octo__demo__7__aaaaaaaaaaaa", SHA);

function captureLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino({ level: "debug" }, { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) });
  return { logger, lines };
}

const payload = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
  ref,
  headSha: SHA,
  event: "REQUEST_CHANGES",
  body: `## Verdict\n\nChanges requested.\n\n${MARKER}`,
  comments: [
    { path: "src/a.ts", line: 12, side: "RIGHT", body: "SQL injection here." },
    { path: "src/b.ts", line: 20, startLine: 15, side: "RIGHT", body: "Missing test for this branch." },
  ],
  ...over,
});

const endsWithMarker = (body: string) => expect(body.endsWith(MARKER)).toBe(true);

describe("marker", () => {
  it("has the exact format and round-trips", () => {
    expect(MARKER).toBe(`<!-- ai-reviewer run=octo__demo__7__aaaaaaaaaaaa sha=${SHA} -->`);
    expect(parseMarker(`# Review\n\nbody\n\n${MARKER}\n`)).toEqual({ runId: "octo__demo__7__aaaaaaaaaaaa", headSha: SHA });
  });

  it("returns null without a marker and picks the last one when several exist", () => {
    expect(parseMarker("no marker <!-- other comment -->")).toBeNull();
    expect(parseMarker(null)).toBeNull();
    const body = `${reviewMarker("r1", OTHER)}\ntext\n${reviewMarker("r2", SHA)}`;
    expect(parseMarker(body)).toEqual({ runId: "r2", headSha: SHA });
    expect(findLastMarker(body)?.index).toBe(body.lastIndexOf("<!--"));
  });
});

describe("findExistingReview", () => {
  it("returns the id of the review carrying this SHA's marker (across pages)", async () => {
    const api = new FakeGitHubApi().on(REVIEWS, (p) =>
      p.page === 1
        ? respond([{ id: 1, body: "human review" }, { id: 2, body: null }, { id: 3, body: `old\n${reviewMarker("r0", OTHER)}` }], { link: nextLink(2) })
        : respond([{ id: 4, body: `new\n\n${MARKER}` }]),
    );
    await expect(createGitHubPublisher(api).findExistingReview(ref, SHA)).resolves.toBe(4);
    expect(api.calls[0]?.params).toMatchObject({ owner: "octo", repo: "demo", pull_number: 7, per_page: 100 });
  });

  it("returns null when no review has this SHA's marker", async () => {
    const api = new FakeGitHubApi().on(REVIEWS, () => [{ id: 3, body: `old\n${reviewMarker("r0", OTHER)}` }, { id: 5, body: "lgtm" }]);
    await expect(createGitHubPublisher(api).findExistingReview(ref, SHA)).resolves.toBeNull();
  });
});

describe("publish", () => {
  it("posts one review pinned to the head SHA with RIGHT-side comments", async () => {
    const api = new FakeGitHubApi().on(CREATE, () => ({ id: 99 }));
    const res = await createGitHubPublisher(api).publish(payload());
    expect(res).toEqual({ reviewId: 99, inlinePosted: 2 });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.params).toEqual({
      owner: "octo",
      repo: "demo",
      pull_number: 7,
      commit_id: SHA,
      event: "REQUEST_CHANGES",
      body: payload().body,
      comments: [
        { path: "src/a.ts", line: 12, side: "RIGHT", body: "SQL injection here." },
        { path: "src/b.ts", line: 20, side: "RIGHT", start_line: 15, start_side: "RIGHT", body: "Missing test for this branch." },
      ],
    });
  });

  it("drops start_line when it is not before line (GitHub would 422)", async () => {
    const api = new FakeGitHubApi().on(CREATE, () => ({ id: 1 }));
    await createGitHubPublisher(api).publish(payload({ comments: [{ path: "x.ts", line: 4, startLine: 4, side: "RIGHT", body: "b" }] }));
    expect(api.calls[0]?.params.comments).toEqual([{ path: "x.ts", line: 4, side: "RIGHT", body: "b" }]);
  });

  it("on 422 retries exactly once with comments folded into the body, marker last", async () => {
    const { logger, lines } = captureLogger();
    const api = new FakeGitHubApi().on(CREATE, (_p, call) => {
      if (call === 0) {
        throw new FakeRequestError(422, "Unprocessable Entity", {
          data: { message: "Unprocessable Entity", errors: ["Line could not be resolved"] },
        });
      }
      return { id: 100 };
    });
    const res = await createGitHubPublisher(api, { logger }).publish(payload());
    expect(res).toEqual({ reviewId: 100, inlinePosted: 0 });
    expect(api.calls).toHaveLength(2);

    const retry = api.calls[1]!.params;
    expect(retry.comments).toEqual([]);
    expect(retry.commit_id).toBe(SHA);
    const body = retry.body as string;
    expect(body).toContain("Inline comments (could not be placed)");
    expect(body).toContain("**`src/a.ts`** (line 12)");
    expect(body).toContain("SQL injection here.");
    expect(body).toContain("**`src/b.ts`** (lines 15-20)");
    expect(body.indexOf("## Verdict")).toBeLessThan(body.indexOf("<details>"));
    endsWithMarker(body);
    expect(body.match(/ai-reviewer run=/g)).toHaveLength(1);

    const warn = lines.find((l) => l.level === 40);
    expect(warn?.failedComments).toEqual(["src/a.ts:12", "src/b.ts:15-20"]);
    expect(warn?.githubErrors).toEqual({ message: "Unprocessable Entity", errors: ["Line could not be resolved"] });
    expect(JSON.stringify(lines)).not.toContain("SQL injection");
  });

  it("propagates a 422 from the retry (no second retry)", async () => {
    const api = new FakeGitHubApi().on(CREATE, () => {
      throw new FakeRequestError(422);
    });
    const { logger } = captureLogger();
    await expect(createGitHubPublisher(api, { logger }).publish(payload())).rejects.toMatchObject({ status: 422 });
    expect(api.calls).toHaveLength(2);
  });

  it("does not retry a 422 when there were no inline comments", async () => {
    const api = new FakeGitHubApi().on(CREATE, () => {
      throw new FakeRequestError(422);
    });
    await expect(createGitHubPublisher(api).publish(payload({ comments: [] }))).rejects.toMatchObject({ status: 422 });
    expect(api.calls).toHaveLength(1);
  });

  it.each([403, 429, 500])("propagates %i as a retryable (non-permanent) error", async (status) => {
    const api = new FakeGitHubApi().on(CREATE, () => {
      throw new FakeRequestError(status);
    });
    const err = await createGitHubPublisher(api).publish(payload()).catch((e: unknown) => e);
    expect(err).toMatchObject({ status });
    expect(isPermanent(err)).toBe(false);
    expect(api.calls).toHaveLength(1);
  });

  it("caps an oversized body and keeps the marker at the end", async () => {
    const api = new FakeGitHubApi().on(CREATE, () => ({ id: 7 }));
    const huge = `## Verdict\n\nChanges requested.\n\n<details>\n<summary>More</summary>\n\n${"- finding line\n".repeat(10_000)}</details>\n\n${MARKER}`;
    await createGitHubPublisher(api).publish(payload({ body: huge }));
    const body = api.calls[0]!.params.body as string;
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(body.startsWith("## Verdict")).toBe(true);
    expect(body).toContain("truncated");
    expect(body.match(/<details>/g)?.length).toBe(body.match(/<\/details>/g)?.length);
    endsWithMarker(body);
  });

  it("caps the folded 422 body too", async () => {
    const api = new FakeGitHubApi().on(CREATE, (_p, call) => {
      if (call === 0) throw new FakeRequestError(422);
      return { id: 8 };
    });
    const { logger } = captureLogger();
    const comments = Array.from({ length: 15 }, (_, i) => ({ path: `f${i}.ts`, line: i + 1, side: "RIGHT" as const, body: "x".repeat(6_000) }));
    await createGitHubPublisher(api, { logger }).publish(payload({ comments }));
    const body = api.calls[1]!.params.body as string;
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(body.startsWith("## Verdict")).toBe(true);
    endsWithMarker(body);
  });

  it("appends a marker when the body has none, so retries stay idempotent", async () => {
    const api = new FakeGitHubApi().on(CREATE, () => ({ id: 9 }));
    const { logger } = captureLogger();
    await createGitHubPublisher(api, { logger }).publish(payload({ body: "no marker" }));
    expect(parseMarker(api.calls[0]!.params.body as string)).toEqual({ runId: "unknown", headSha: SHA });
  });
});

describe("capBody", () => {
  it("leaves short bodies alone", () => {
    const body = `hello\n\n${MARKER}`;
    expect(capBody(body)).toBe(body);
  });

  it("closes an open code fence and never splits a surrogate pair", () => {
    const body = `intro\n\n\`\`\`ts\n${"😀".repeat(40_000)}\n\`\`\`\n\n${MARKER}`;
    const out = capBody(body, 5_000);
    expect(out.length).toBeLessThanOrEqual(5_000);
    expect(out.match(/```/g)?.length).toBe(2);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out.endsWith(MARKER)).toBe(true);
  });
});
