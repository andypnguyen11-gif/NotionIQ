import { Worker } from 'bullmq'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { decryptToken } from '@/lib/crypto/token-cipher'
import { createRateLimiter } from '@/lib/notion/rate-limiter'
import { createNotionClient } from '@/lib/notion/notion-client'
import { scanDatabases } from '@/lib/notion/scanner'
import { mapSchema } from '@/lib/agents/schema-mapper'
import { createToolCaller, createAnthropicSdk } from '@/lib/agents/anthropic-client'
import { upsertProposedMapping, listApprovedMappings } from '@/lib/data/mappings'
import { setRunResults } from '@/lib/data/scan-runs'
import { runScan, type RunScanDeps } from './run-scan'
import { SCAN_QUEUE, type ScanJob } from './queue'
import { collectTypedRows } from '@/lib/notion/typed-reader'
import { writeSnapshotRecords, commitSnapshot, cleanOrphanCandidates } from '@/lib/data/normalized'
import { setSnapshotRunStatus } from '@/lib/data/snapshot-runs'
import { runSnapshot, type RunSnapshotDeps } from './run-snapshot'
import { SNAPSHOT_QUEUE, type SnapshotJob } from './snapshot-queue'

const MODEL = 'claude-sonnet-4-6'

function buildDeps(): RunScanDeps {
  const prisma = getPrisma()
  const env = getEnv()
  const toolCaller = createToolCaller({ sdk: createAnthropicSdk(env.ANTHROPIC_API_KEY) })
  return {
    async loadRun(scanRunId) {
      const run = await prisma.workspaceScanRun.findUniqueOrThrow({
        where: { id: scanRunId },
        include: { workspace: { include: { notionConnection: true } } },
      })
      return { workspaceId: run.workspaceId, selectedDatabaseIds: run.selectedDatabaseIds as string[] }
    },
    async scan(workspaceId, databaseIds) {
      const conn = await prisma.notionConnection.findUniqueOrThrow({ where: { workspaceId } })
      const token = decryptToken(conn.encryptedToken, env.TOKEN_ENCRYPTION_KEY, conn.notionWorkspaceId)
      const client = createNotionClient({ token, rateLimiter: createRateLimiter({ ratePerSec: 3 }) })
      return scanDatabases(client, databaseIds)
    },
    async map(db) {
      const { proposal, model } = await mapSchema({ toolCaller, model: MODEL }, db)
      return { proposal, model }
    },
    async upsert(args) {
      await upsertProposedMapping(prisma, {
        workspaceId: args.workspaceId,
        notionDatabaseId: args.db.notionDatabaseId,
        databaseName: args.db.databaseName,
        schema: args.db.properties,
        schemaHash: args.schemaHash,
        proposal: args.proposal,
        scanRunId: args.scanRunId,
      })
    },
    async finish(scanRunId, a) {
      await setRunResults(prisma, { scanRunId, ...a })
    },
  }
}

function buildSnapshotDeps(): RunSnapshotDeps {
  const prisma = getPrisma()
  const env = getEnv()
  return {
    async loadRun(snapshotRunId) {
      const run = await prisma.snapshotRun.findUniqueOrThrow({ where: { id: snapshotRunId }, include: { workspace: true } })
      return { workspaceId: run.workspaceId, currentVersion: run.workspace.snapshotVersion }
    },
    loadApprovedMappings: (workspaceId) => listApprovedMappings(prisma, workspaceId),
    cleanOrphans: (workspaceId, currentVersion) => cleanOrphanCandidates(prisma, { workspaceId, currentVersion }),
    async read(notionDatabaseId) {
      // Resolve the workspace from the database row, then decrypt its token for the typed pull.
      const mapping = await prisma.databaseMapping.findFirstOrThrow({ where: { notionDatabaseId }, include: { workspace: { include: { notionConnection: true } } } })
      const conn = mapping.workspace.notionConnection
      if (!conn) throw Object.assign(new Error('no connection'), { code: 'NO_CONNECTION' })
      const token = decryptToken(conn.encryptedToken, env.TOKEN_ENCRYPTION_KEY, conn.notionWorkspaceId)
      const client = createNotionClient({ token, rateLimiter: createRateLimiter({ ratePerSec: 3 }) })
      return collectTypedRows(client, notionDatabaseId)
    },
    write: (args) => writeSnapshotRecords(prisma, args),
    commit: (workspaceId, version) => commitSnapshot(prisma, { workspaceId, version }),
    setStatus: (snapshotRunId, args) => setSnapshotRunStatus(prisma, { snapshotRunId, ...args }),
  }
}

const connection = { url: getEnv().REDIS_URL, maxRetriesPerRequest: null }
new Worker<ScanJob>(SCAN_QUEUE, async (job) => runScan(buildDeps(), job.data.scanRunId), { connection })
new Worker<SnapshotJob>(SNAPSHOT_QUEUE, async (job) => runSnapshot(buildSnapshotDeps(), job.data.snapshotRunId), { connection })
