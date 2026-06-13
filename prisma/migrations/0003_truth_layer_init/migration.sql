-- CreateTable
CREATE TABLE "NormalizedRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceDatabaseId" TEXT NOT NULL,
    "notionPageId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3),
    "snapshotVersion" INTEGER NOT NULL,
    "mappedFields" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NormalizedRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnapshotRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "snapshotVersion" INTEGER,
    "results" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SnapshotRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NormalizedRecord_workspaceId_sourceDatabaseId_notionPageId_snapshotVersion_key" ON "NormalizedRecord"("workspaceId", "sourceDatabaseId", "notionPageId", "snapshotVersion");

-- CreateIndex
CREATE INDEX "NormalizedRecord_workspaceId_snapshotVersion_sourceDatabaseId_idx" ON "NormalizedRecord"("workspaceId", "snapshotVersion", "sourceDatabaseId");

-- CreateIndex
CREATE INDEX "NormalizedRecord_workspaceId_snapshotVersion_occurredAt_idx" ON "NormalizedRecord"("workspaceId", "snapshotVersion", "occurredAt");

-- CreateIndex
CREATE INDEX "SnapshotRun_workspaceId_idx" ON "SnapshotRun"("workspaceId");

-- AddForeignKey
ALTER TABLE "NormalizedRecord" ADD CONSTRAINT "NormalizedRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SnapshotRun" ADD CONSTRAINT "SnapshotRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
