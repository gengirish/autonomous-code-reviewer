import Fastify from "fastify";
import type { FastifyError, FastifyInstance, FastifyPluginAsync } from "fastify";
import { ForbiddenError, UnauthorizedError } from "../core/errors.js";
import type { HookDeps, StatsReader } from "../core/ports.js";
import { basicAuthHook } from "./auth/basic.js";
import type { BasicCredentials } from "./auth/basic.js";
import { healthRoutes } from "./routes/health.js";
import { hookRoutes } from "./routes/hook.js";
import { statsRoutes } from "./routes/stats.js";

export type ServerDeps = HookDeps & {
  /** Mounted under /admin behind basic auth (e.g. Bull Board). Requires `admin`. */
  adminPlugin?: FastifyPluginAsync;
  /** Serves GET /admin/stats/runs behind basic auth. Ignored unless `admin` is set. */
  stats?: StatsReader;
  admin?: BasicCredentials;
  /** Fastify logger option. Default false. Never logs request headers (so never the token). */
  logger?: boolean | object;
};

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  if (deps.adminPlugin && (!deps.admin?.user || !deps.admin.password)) {
    throw new Error("adminPlugin requires admin credentials (BULL_BOARD_USER / BULL_BOARD_PASSWORD)");
  }

  const app = Fastify({
    logger: deps.logger ?? false,
    // Don't trust X-Forwarded-* blindly; Fly's proxy is configured separately if needed.
    trustProxy: false,
  });

  app.setErrorHandler<FastifyError>((err, request, reply) => {
    if (err instanceof UnauthorizedError) {
      return reply.code(401).header("www-authenticate", "Bearer").send({ error: "unauthorized", message: err.message });
    }
    if (err instanceof ForbiddenError) {
      return reply.code(403).send({ error: "forbidden", message: err.message });
    }
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      // Fastify client errors (malformed JSON, 413, 415, …): safe to echo.
      return reply.code(status).send({ error: err.code ?? "bad request", message: err.message });
    }
    request.log.error({ err: { name: err.name, message: err.message } }, "request failed");
    return reply.code(500).send({ error: "internal error" });
  });

  await app.register(healthRoutes);
  await app.register(async (scope) => hookRoutes(scope, deps));

  // One /admin scope behind basic auth for everything admin (Bull Board, stats). Without
  // credentials nothing under /admin is registered: it fails closed.
  const { adminPlugin, stats } = deps;
  if (deps.admin && (adminPlugin || stats)) {
    const auth = basicAuthHook(deps.admin);
    await app.register(
      async (scope) => {
        // Hooks added here apply to every route registered in this scope (encapsulation).
        scope.addHook("onRequest", auth);
        if (adminPlugin) await scope.register(adminPlugin);
        if (stats) await statsRoutes(scope, stats);
      },
      { prefix: "/admin" },
    );
  }

  return app;
}
