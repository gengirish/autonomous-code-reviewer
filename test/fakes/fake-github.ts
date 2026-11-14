import type { PrFile, PrMeta, PrSource, ReviewPayload, ReviewPublisher } from "../../src/core/ports.js";
import type { PrRef } from "../../src/schemas/index.js";

export class FakePrSource implements PrSource {
  readonly calls: string[] = [];

  constructor(
    readonly meta: PrMeta,
    readonly files: PrFile[],
    /** path → head contents */
    readonly contents: Record<string, string>,
    readonly repoFiles: Record<string, string> = {},
  ) {}

  async getPr(_ref: PrRef) {
    this.calls.push("getPr");
    return this.meta;
  }
  async listFiles(_ref: PrRef) {
    this.calls.push("listFiles");
    return this.files;
  }
  async getContent(_ref: PrRef, file: PrFile) {
    this.calls.push(`getContent:${file.path}`);
    const c = this.contents[file.path];
    if (c === undefined) throw new Error(`FakePrSource: no content for ${file.path}`);
    return c;
  }
  async getRepoFile(_ref: PrRef, path: string) {
    return this.repoFiles[path] ?? null;
  }
}

export class FakePublisher implements ReviewPublisher {
  readonly published: ReviewPayload[] = [];
  private nextId = 1000;

  constructor(private readonly existing: Record<string, number> = {}) {}

  async findExistingReview(ref: PrRef, headSha: string) {
    return this.existing[`${ref.owner}/${ref.repo}#${ref.pr}@${headSha}`] ?? null;
  }
  async publish(review: ReviewPayload) {
    this.published.push(review);
    const reviewId = this.nextId++;
    this.existing[`${review.ref.owner}/${review.ref.repo}#${review.ref.pr}@${review.headSha}`] = reviewId;
    return { reviewId, inlinePosted: review.comments.length };
  }
}
