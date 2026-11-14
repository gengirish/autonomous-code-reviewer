import type { ContextStore } from "../../src/core/ports.js";
import type { PrRef, ReviewContext } from "../../src/schemas/index.js";

export class MemoryContextStore implements ContextStore {
  private readonly contexts = new Map<string, ReviewContext[]>();
  private readonly latest = new Map<string, string>();

  async putContexts(runId: string, contexts: ReviewContext[]) {
    this.contexts.set(runId, structuredClone(contexts));
  }
  async getContexts(runId: string) {
    return structuredClone(this.contexts.get(runId) ?? null);
  }
  async setLatest(ref: PrRef, headSha: string) {
    this.latest.set(`${ref.owner}/${ref.repo}#${ref.pr}`, headSha);
  }
  async getLatest(ref: PrRef) {
    return this.latest.get(`${ref.owner}/${ref.repo}#${ref.pr}`) ?? null;
  }
}
