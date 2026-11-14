import type { PrSource, ReviewPublisher } from "../core/ports.js";
import type { Logger } from "../core/logger.js";
import type { PrRef } from "../schemas/index.js";
import type { GitHubAppClient } from "./app-auth.js";
import { createGitHubPrSource } from "./pr-source.js";
import { createGitHubPublisher } from "./publisher.js";

export * from "./api.js";
export * from "./app-auth.js";
export * from "./marker.js";
export * from "./pr-source.js";
export * from "./publisher.js";

export interface GitHubFactories {
  prSourceFor(ref: PrRef): Promise<PrSource>;
  publisherFor(ref: PrRef): Promise<ReviewPublisher>;
}

/** Per-PR factories used by the worker. Installation lookups are cached inside `app`. */
export function createGitHubFactories(app: GitHubAppClient, opts: { logger?: Logger } = {}): GitHubFactories {
  return {
    async prSourceFor(ref) {
      return createGitHubPrSource(await app.apiFor(ref.owner, ref.repo));
    },
    async publisherFor(ref) {
      return createGitHubPublisher(await app.apiFor(ref.owner, ref.repo), opts);
    },
  };
}
