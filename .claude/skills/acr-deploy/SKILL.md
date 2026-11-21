---
name: acr-deploy
description: >-
  Deploying ACR to Fly.io: Dockerfile, fly.toml with web and worker process groups,
  Upstash Redis via fly redis create, Postgres, secrets, migrations on release, scaling,
  logs, and the live smoke test on the sandbox repo. Use when editing Dockerfile or
  fly.toml, setting secrets, deploying, scaling, or debugging production on Fly.
---

# Deploy (Fly.io)

**Deploying, setting secrets and scaling are outward-facing. Confirm with the user before
running `fly deploy`, `fly secrets set`, `fly scale` or `fly redis create`.**
Read-only commands (`fly status`, `fly logs`) are fine.

## Topology

```
Fly app: ai-code-reviewer-gengirish  (region sin; "ai-code-reviewer" is taken on Fly)
  process "web"     Fastify :8080, http_service, auto-stop allowed (min 0)
  process "worker"  BullMQ workers, no http, always 1 running
  Upstash Redis     fly redis create (private IPv6 URL)
  Postgres          Neon (pooled) or Fly Postgres
```

## Dockerfile (multi-stage)

The real file is `Dockerfile` at the repo root (verified: image builds, `/healthz` serves,
`npx prisma migrate deploy` runs, worker fails fast without secrets). Gotchas it encodes:

- `prisma` is a **runtime dependency** (the `release_command` runs `prisma migrate deploy` in the image).
- The runtime stage needs **OpenSSL** for Prisma's migrate engine, and **must not** use
  `npm ci --ignore-scripts`. The install scripts download that engine.
- The Prisma 7 client is generated into `src/db/generated/` and compiled into `dist/`. The build
  stage needs `prisma generate` before `tsc`.
- `npm run build` copies grammars, agent prompts and judge prompt/rubric into `dist/` (`scripts/copy-assets.mjs`).
- The image is about 1 GB (Prisma engines included). Slimming it is a phase 7 task.

Local check: `docker build -t acr:local . && docker run --rm -p 8098:8080 -e REDIS_URL=redis://host.docker.internal:6379 acr:local`.

## fly.toml

```toml
app = "ai-code-reviewer-gengirish"
primary_region = "sin"            # Upstash rejects bom for new DBs; Neon is ap-southeast-1 too
kill_signal = "SIGTERM"
kill_timeout = 60                 # let in-flight Claude calls finish (acr-queue shutdown)

[deploy]
  release_command = "npx prisma migrate deploy"

[processes]
  web = "node dist/server/index.js"
  worker = "node dist/worker/index.js"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0
  processes = ["web"]

  [[http_service.checks]]
    method = "GET"
    path = "/healthz"
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
  processes = ["web"]

[[vm]]
  size = "shared-cpu-1x"
  memory = "1gb"                  # tree-sitter WASM + parallel agent jobs
  processes = ["worker"]
```

`/healthz` must not touch Redis or Postgres. A dependency-checking health probe every 30 s
keeps paid resources awake (`idle-cost-audit`).

## First deploy (each step needs user confirmation)

```bash
fly launch --no-deploy                      # creates the app; keep the fly.toml above
fly redis create --name ai-code-reviewer-redis --region sin --no-replicas \
  --disable-eviction --plan "Pay-as-you-go" --enable-prodpack=false   # BullMQ needs eviction off
# Done 2026-11-21: app, Redis, Neon project ai-code-reviewer-db, web deployed with
#   fly deploy --ha=false --process-groups web --remote-only
fly secrets set ANTHROPIC_API_KEY=… GITHUB_APP_ID=… GITHUB_APP_PRIVATE_KEY_B64=… \
  REDIS_URL=… DATABASE_URL=… DIRECT_URL=… OIDC_AUDIENCE=ai-reviewer ALLOWED_OWNERS=<owner> \
  BULL_BOARD_USER=… BULL_BOARD_PASSWORD=…
fly deploy --ha=false                       # otherwise Fly creates 2 machines per process
fly scale count web=1 worker=1
```

Then set the `AI_REVIEWER_URL=https://<app>.fly.dev` repository variable on the sandbox
repo, and add `action/ai-review.yml` to it.

## Smoke test (ACR done-gate station 8)

1. `curl -s https://<app>.fly.dev/healthz` returns 200.
2. Push a commit to the sandbox PR that contains a seeded issue (e.g. SQL concatenation).
3. The Action run shows `reviewer 202`.
4. `fly logs -a <app>` shows `prepare → 4 agents → judge → publish` for that runId.
5. The PR shows a review from `ai-reviewer[bot]` for that SHA, with the seeded issue inline.
6. Push again with no changes to that file: no duplicate review for the old SHA, and a new review for the new one.

## Operations

```bash
fly status -a <app>
fly logs -a <app>                           # pino JSON; filter by runId
fly ssh console -a <app> --process-group worker
fly secrets list -a <app>                   # names only
```

Bull Board: `https://<app>.fly.dev/admin/queues` (basic auth).

Cost watch: the worker machine and Redis are always on. If either bill grows without traffic,
run `idle-cost-audit` before changing settings.
