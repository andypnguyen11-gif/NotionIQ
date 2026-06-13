-- Single-flight guard: at most one in-flight (queued|running) SnapshotRun per workspace.
-- Two concurrent runs both target snapshotVersion N+1, and one run's candidate-row cleanup
-- (cleanOrphanCandidates: delete where snapshotVersion > currentVersion) would delete the
-- other run's just-written candidate rows — corrupting a snapshot that then commits as
-- "complete". This partial unique index makes that race impossible at the DB level.
--
-- Filtered/partial unique indexes are not expressible in the Prisma schema DSL, so this index
-- is defined in raw SQL and is intentionally absent from schema.prisma. The application layer
-- (lib/data/snapshot-runs.ts) short-circuits the common case and catches the P2002 violation
-- this index raises on the losing side of a race.

-- CreateIndex
CREATE UNIQUE INDEX "SnapshotRun_workspaceId_active_key" ON "SnapshotRun"("workspaceId") WHERE "status" IN ('queued', 'running');
