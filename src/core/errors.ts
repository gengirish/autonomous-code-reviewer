/**
 * Domain errors. Workers map PermanentError (and subclasses) to BullMQ's
 * UnrecoverableError so the job is not retried; everything else is retried with backoff.
 */
export class PermanentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Claude declined (stop_reason "refusal"). */
export class AgentRefusedError extends PermanentError {
  constructor(
    readonly label: string,
    readonly category: string | null,
  ) {
    super(`${label} refused (category: ${category ?? "unknown"})`);
  }
}

/** LLM output failed schema validation after the in-process retry. */
export class SchemaError extends PermanentError {}

/** GitHub App is not installed on the repo, PR closed, etc. */
export class NotReviewableError extends PermanentError {}

/** Auth failures at the hook (map to HTTP 401/403). */
export class UnauthorizedError extends Error {
  readonly statusCode = 401;
}
export class ForbiddenError extends Error {
  readonly statusCode = 403;
}

export const isPermanent = (err: unknown): err is PermanentError => err instanceof PermanentError;
