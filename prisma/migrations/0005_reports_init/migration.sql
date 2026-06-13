-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "notionPageId" TEXT NOT NULL,
    "ownedBlockIds" TEXT[],
    "lastRunId" TEXT,
    "lastSnapshotVersion" INTEGER,
    "lastGeneratedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "snapshotVersion" INTEGER,
    "model" TEXT,
    "promptVersion" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "results" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportClaim" (
    "id" TEXT NOT NULL,
    "reportRunId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT,
    "template" TEXT NOT NULL,
    "renderedText" TEXT,
    "factId" TEXT,
    "factValue" JSONB,
    "factSnapshot" JSONB,
    "verificationStatus" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReportClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Report_workspaceId_key" ON "Report"("workspaceId");
CREATE INDEX "Report_workspaceId_idx" ON "Report"("workspaceId");
CREATE INDEX "ReportRun_workspaceId_idx" ON "ReportRun"("workspaceId");
CREATE INDEX "ReportClaim_reportRunId_idx" ON "ReportClaim"("reportRunId");
CREATE INDEX "ReportClaim_workspaceId_idx" ON "ReportClaim"("workspaceId");

-- Single-flight: at most one in-flight (queued|running|rewriting) ReportRun per workspace.
-- `rewriting` (write-only retry) is included so a retry and a fresh POST /api/report cannot
-- both write the managed page. Partial unique indexes are not expressible in the Prisma DSL,
-- so this is raw SQL and intentionally absent from schema.prisma; lib/data/reports.ts catches
-- the P2002 this raises on the losing side of a race.
CREATE UNIQUE INDEX "ReportRun_workspaceId_active_key"
  ON "ReportRun"("workspaceId") WHERE "status" IN ('queued', 'running', 'rewriting');

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportClaim" ADD CONSTRAINT "ReportClaim_reportRunId_fkey" FOREIGN KEY ("reportRunId") REFERENCES "ReportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReportClaim" ADD CONSTRAINT "ReportClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
