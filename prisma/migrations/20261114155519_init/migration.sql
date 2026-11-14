-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'PUBLISHED', 'SUPERSEDED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "ReviewRun" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "pr" INTEGER NOT NULL,
    "headSha" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "verdict" TEXT,
    "reviewId" BIGINT,
    "chunks" INTEGER NOT NULL DEFAULT 1,
    "costUsd" DECIMAL(10,4),
    "latencyMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ReviewRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentReport" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "chunk" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "summary" TEXT,

    CONSTRAINT "AgentReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceAgents" TEXT[],
    "file" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "agentSeverity" TEXT NOT NULL,
    "finalSeverity" TEXT NOT NULL,
    "kept" BOOLEAN NOT NULL,
    "dropReason" TEXT,
    "inline" BOOLEAN NOT NULL DEFAULT false,
    "githubCommentId" BIGINT,
    "title" TEXT NOT NULL,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "cacheWriteTokens" INTEGER NOT NULL,
    "stopReason" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "costUsd" DECIMAL(10,5) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "reaction" TEXT NOT NULL,
    "githubUser" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewRun_owner_repo_pr_idx" ON "ReviewRun"("owner", "repo", "pr");

-- CreateIndex
CREATE INDEX "ReviewRun_status_createdAt_idx" ON "ReviewRun"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRun_owner_repo_pr_headSha_key" ON "ReviewRun"("owner", "repo", "pr", "headSha");

-- CreateIndex
CREATE INDEX "AgentReport_runId_idx" ON "AgentReport"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentReport_runId_agent_chunk_key" ON "AgentReport"("runId", "agent", "chunk");

-- CreateIndex
CREATE INDEX "Finding_runId_idx" ON "Finding"("runId");

-- CreateIndex
CREATE INDEX "Finding_category_idx" ON "Finding"("category");

-- CreateIndex
CREATE INDEX "Finding_githubCommentId_idx" ON "Finding"("githubCommentId");

-- CreateIndex
CREATE INDEX "LlmCall_runId_idx" ON "LlmCall"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "Feedback_findingId_githubUser_reaction_key" ON "Feedback"("findingId", "githubUser", "reaction");

-- AddForeignKey
ALTER TABLE "AgentReport" ADD CONSTRAINT "AgentReport_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmCall" ADD CONSTRAINT "LlmCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;
