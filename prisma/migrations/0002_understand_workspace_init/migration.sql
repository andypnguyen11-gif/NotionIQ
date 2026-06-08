-- CreateTable
CREATE TABLE "WorkspaceScanRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "selectedDatabaseIds" JSONB NOT NULL,
    "results" JSONB,
    "propertyCount" INTEGER,
    "sampleRowCount" INTEGER,
    "mapperModel" TEXT,
    "mapperPromptVersion" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceScanRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatabaseMapping" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "notionDatabaseId" TEXT NOT NULL,
    "databaseName" TEXT NOT NULL,
    "classification" TEXT,
    "schema" JSONB NOT NULL,
    "schemaHash" TEXT NOT NULL,
    "proposedMapping" JSONB NOT NULL,
    "approvedMapping" JSONB,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "confidence" DOUBLE PRECISION,
    "lastScanRunId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DatabaseMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceScanRun_workspaceId_idx" ON "WorkspaceScanRun"("workspaceId");
CREATE INDEX "DatabaseMapping_workspaceId_idx" ON "DatabaseMapping"("workspaceId");
CREATE UNIQUE INDEX "DatabaseMapping_workspaceId_notionDatabaseId_key" ON "DatabaseMapping"("workspaceId", "notionDatabaseId");

-- AddForeignKey
ALTER TABLE "WorkspaceScanRun" ADD CONSTRAINT "WorkspaceScanRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DatabaseMapping" ADD CONSTRAINT "DatabaseMapping_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DatabaseMapping" ADD CONSTRAINT "DatabaseMapping_lastScanRunId_fkey" FOREIGN KEY ("lastScanRunId") REFERENCES "WorkspaceScanRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
