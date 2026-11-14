import { pino } from "pino";

/** Structured JSON logs. Never log tokens, keys, prompts or code contents: log IDs and counts. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "authorization",
      "headers.authorization",
      "req.headers.authorization",
      "token",
      "*.token",
      "privateKey",
      "*.privateKey",
      "apiKey",
      "*.apiKey",
    ],
    censor: "[redacted]",
  },
  transport:
    process.env.NODE_ENV === "development" ? { target: "pino-pretty", options: { colorize: true } } : undefined,
});

export type Logger = typeof logger;
