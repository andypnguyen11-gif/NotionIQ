-- CreateTable
CREATE TABLE "Chart" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceDatabaseId" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "snapshotVersionAtCreate" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Chart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Chart_workspaceId_idx" ON "Chart"("workspaceId");

-- AddForeignKey
ALTER TABLE "Chart" ADD CONSTRAINT "Chart_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
