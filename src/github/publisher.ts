import type { ReviewComment, ReviewPublisher } from "../core/ports.js";
import { logger as defaultLogger, type Logger } from "../core/logger.js";
import { statusOf, type GitHubApi } from "./api.js";
import { findLastMarker, hasMarkerForSha, reviewMarker } from "./marker.js";

/** GitHub's limit on a review body. */
export const MAX_BODY_CHARS = 65_536;

const TRUNCATION_NOTICE = "\n\n_…truncated: the review exceeded GitHub's 65,536-character limit._";

interface ReviewListItem {
  id: number;
  body: string | null;
}

interface ApiReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "RIGHT";
}

export function toApiComment(c: ReviewComment): ApiReviewComment {
  const out: ApiReviewComment = { path: c.path, line: c.line, side: "RIGHT", body: c.body };
  // GitHub rejects (422) a multi-line range whose start is not strictly before its end.
  if (c.startLine !== undefined && c.startLine < c.line) {
    out.start_line = c.startLine;
    out.start_side = "RIGHT";
  }
  return out;
}

/** Splits the body into content and the trailing marker (if any). */
function splitMarker(body: string): { content: string; marker: string } {
  const m = findLastMarker(body);
  if (!m) return { content: body, marker: "" };
  // Text after the marker is moved before it: the marker must stay last.
  const before = body.slice(0, m.index).trimEnd();
  const after = body.slice(m.index + m.text.length).trim();
  return { content: after ? `${before}\n\n${after}` : before, marker: m.text };
}

/** Cuts at `max` UTF-16 units without splitting a surrogate pair. */
function sliceSafe(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max);
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** Closes code fences and <details> blocks left open by truncation. */
function closeOpenBlocks(s: string): string {
  let tail = "";
  const fences = s.match(/^[ \t]*```/gm)?.length ?? 0;
  if (fences % 2 === 1) tail += "\n```";
  const opens = s.match(/<details\b/gi)?.length ?? 0;
  const closes = s.match(/<\/details>/gi)?.length ?? 0;
  for (let i = closes; i < opens; i++) tail += "\n</details>";
  return tail;
}

/**
 * Ensures the body fits GitHub's limit, keeping the marker as the very last thing.
 * Truncates from the end of the content (the renderer puts the verdict first and details last).
 */
export function capBody(body: string, max = MAX_BODY_CHARS): string {
  const { content, marker } = splitMarker(body);
  const assemble = (c: string) => (marker ? `${c}\n\n${marker}` : c);
  if (assemble(content).length <= max) return assemble(content);

  const reserved = TRUNCATION_NOTICE.length + (marker ? marker.length + 2 : 0);
  // Worst-case closing tail: one fence plus every open <details>.
  const opens = content.match(/<details\b/gi)?.length ?? 0;
  const tailBudget = 4 + opens * "\n</details>".length;
  let kept = sliceSafe(content, max - reserved - tailBudget);
  // Avoid cutting through an HTML tag or the middle of a line where cheap to do so.
  const lastNl = kept.lastIndexOf("\n");
  if (lastNl > kept.length - 200 && lastNl > 0) kept = kept.slice(0, lastNl);
  const out = assemble(kept + closeOpenBlocks(kept) + TRUNCATION_NOTICE);
  return out.length <= max ? out : sliceSafe(out, max);
}

/** Folds inline comments into the body (before the marker) for the 422 fallback. */
export function foldComments(body: string, comments: ReviewComment[]): string {
  const { content, marker } = splitMarker(body);
  const items = comments.map((c) => {
    const where = c.startLine !== undefined && c.startLine < c.line ? `lines ${c.startLine}-${c.line}` : `line ${c.line}`;
    return `**\`${c.path}\`** (${where})\n\n${c.body}`;
  });
  const section = [
    "<details>",
    `<summary>Inline comments (could not be placed): ${comments.length}</summary>`,
    "",
    items.join("\n\n---\n\n"),
    "",
    "</details>",
  ].join("\n");
  const folded = `${content}\n\n${section}`;
  return marker ? `${folded}\n\n${marker}` : folded;
}

export function createGitHubPublisher(api: GitHubApi, opts: { logger?: Logger } = {}): ReviewPublisher {
  const log = opts.logger ?? defaultLogger;

  return {
    async findExistingReview(ref, headSha) {
      const reviews = await api.paginate<ReviewListItem>("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.pr,
        per_page: 100,
      });
      const match = reviews.find((r) => hasMarkerForSha(r.body, headSha));
      return match ? match.id : null;
    },

    async publish(review) {
      const { ref, headSha } = review;
      let body = review.body;
      if (!findLastMarker(body)) {
        // Idempotency depends on the marker; the renderer should always add it.
        log.warn({ owner: ref.owner, repo: ref.repo, pr: ref.pr, headSha }, "review body has no marker; appending one");
        body = `${body}\n\n${reviewMarker("unknown", headSha)}`;
      }

      const post = (b: string, comments: ApiReviewComment[]) =>
        api.request<{ id: number }>("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.pr,
          commit_id: headSha,
          event: review.event,
          body: capBody(b),
          comments,
        });

      try {
        const { data } = await post(body, review.comments.map(toApiComment));
        return { reviewId: data.id, inlinePosted: review.comments.length };
      } catch (err) {
        if (statusOf(err) !== 422 || review.comments.length === 0) throw err;
        log.warn(
          {
            owner: ref.owner,
            repo: ref.repo,
            pr: ref.pr,
            headSha,
            failedComments: review.comments.map((c) => `${c.path}:${c.startLine !== undefined ? `${c.startLine}-` : ""}${c.line}`),
            githubErrors: githubErrorsOf(err),
          },
          "inline comments rejected (422); retrying once with comments folded into the body",
        );
        const { data } = await post(foldComments(body, review.comments), []);
        return { reviewId: data.id, inlinePosted: 0 };
      }
    },
  };
}

/** GitHub's `errors` array (or message) from a RequestError, for logs. No request bodies. */
function githubErrorsOf(err: unknown): unknown {
  const data = (err as { response?: { data?: { message?: unknown; errors?: unknown } } }).response?.data;
  if (data) return { message: data.message, errors: data.errors };
  return err instanceof Error ? err.message : String(err);
}
