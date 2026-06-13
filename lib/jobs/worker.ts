import { Worker } from 'bullmq'
import { getEnv } from '@/lib/env'
import { log } from '@/lib/log'
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
import { writeSnapshotRecords, commitSnapshot, cleanOrphanCandidates, getCurrentSnapshotRecords, getSnapshotRecordsAtVersion } from '@/lib/data/normalized'
import { setSnapshotRunStatus } from '@/lib/data/snapshot-runs'
import { runSnapshot, type RunSnapshotDeps } from './run-snapshot'
import { SNAPSHOT_QUEUE, type SnapshotJob } from './snapshot-queue'
import { setReportRunStatus, persistReportClaims, upsertReport, getReport, getVerifiedClaimsForRun, hasPersistedClaims } from '@/lib/data/reports'
import { draftInsights, repairInsights } from '@/lib/agents/insight'
import { runReport, type RunReportDeps } from './run-report'
import { REPORT_QUEUE, type ReportJob } from './report-queue'
import { recoveryStatusFor } from './report-recovery'
import { writeManagedReport } from '@/lib/notion/report-writer'

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
  // One snapshot run targets a single workspace; build its rate-limited client once and reuse
  // it across every database so the 3 req/s limiter is shared (no per-database burst).
  let cached: { workspaceId: string; client: ReturnType<typeof createNotionClient> } | undefined
  async function clientForWorkspace(workspaceId: string) {
    if (cached?.workspaceId === workspaceId) return cached.client
    const conn = await prisma.notionConnection.findUnique({ where: { workspaceId } })
    if (!conn) throw Object.assign(new Error('no connection'), { code: 'NO_CONNECTION' })
    const token = decryptToken(conn.encryptedToken, env.TOKEN_ENCRYPTION_KEY, conn.notionWorkspaceId)
    const client = createNotionClient({ token, rateLimiter: createRateLimiter({ ratePerSec: 3 }) })
    cached = { workspaceId, client }
    return client
  }
  return {
    async loadRun(snapshotRunId) {
      const run = await prisma.snapshotRun.findUniqueOrThrow({ where: { id: snapshotRunId }, include: { workspace: true } })
      return { workspaceId: run.workspaceId, currentVersion: run.workspace.snapshotVersion }
    },
    loadApprovedMappings: (workspaceId) => listApprovedMappings(prisma, workspaceId),
    cleanOrphans: (workspaceId, currentVersion) => cleanOrphanCandidates(prisma, { workspaceId, currentVersion }),
    async read(workspaceId, notionDatabaseId) {
      const client = await clientForWorkspace(workspaceId)
      return collectTypedRows(client, notionDatabaseId)
    },
    write: (args) => writeSnapshotRecords(prisma, args),
    commit: (workspaceId, version) => commitSnapshot(prisma, { workspaceId, version }),
    setStatus: (snapshotRunId, args) => setSnapshotRunStatus(prisma, { snapshotRunId, ...args }),
  }
}

function buildReportDeps(): RunReportDeps {
  const prisma = getPrisma()
  const env = getEnv()
  const toolCaller = createToolCaller({ sdk: createAnthropicSdk(env.ANTHROPIC_API_KEY) })
  let cached: { workspaceId: string; client: ReturnType<typeof createNotionClient> } | undefined
  async function clientForWorkspace(workspaceId: string) {
    if (cached?.workspaceId === workspaceId) return cached.client
    const conn = await prisma.notionConnection.findUniqueOrThrow({ where: { workspaceId } })
    const token = decryptToken(conn.encryptedToken, env.TOKEN_ENCRYPTION_KEY, conn.notionWorkspaceId)
    const client = createNotionClient({ token, rateLimiter: createRateLimiter({ ratePerSec: 3 }) })
    cached = { workspaceId, client }
    return client
  }
  return {
    clock: () => new Date().toISOString(),
    async loadRun(reportRunId) {
      const run = await prisma.reportRun.findUniqueOrThrow({ where: { id: reportRunId }, include: { workspace: true } })
      return { workspaceId: run.workspaceId, currentVersion: run.workspace.snapshotVersion, runSnapshotVersion: run.snapshotVersion }
    },
    async loadFactInputs(workspaceId, currentVersion) {
      const mappings = await listApprovedMappings(prisma, workspaceId)
      if (mappings.length === 0) return null
      const dbs = []
      for (const m of mappings) {
        const current = await getCurrentSnapshotRecords(prisma, { workspaceId, sourceDatabaseId: m.notionDatabaseId })
        const previous = currentVersion > 0 ? await getSnapshotRecordsAtVersion(prisma, { workspaceId, version: currentVersion - 1, sourceDatabaseId: m.notionDatabaseId }) : []
        dbs.push({ sourceDatabaseId: m.notionDatabaseId, mapping: m.approvedMapping, current, previous })
      }
      const context = { databases: mappings.map((m) => ({ sourceDatabaseId: m.notionDatabaseId, classification: m.approvedMapping.classification })) }
      return { dbs, context }
    },
    draft: (input) => draftInsights({ toolCaller, model: MODEL }, input),
    repair: (input) => repairInsights({ toolCaller, model: MODEL }, input),
    persistClaims: (args) => persistReportClaims(prisma, args),
    setStatus: (args) => setReportRunStatus(prisma, args),
    async loadReportPointer(workspaceId) {
      const report = await getReport(prisma, { workspaceId })
      if (report) return { notionPageId: report.notionPageId, ownedBlockIds: report.ownedBlockIds, parentPageId: report.notionPageId }
      const client = await clientForWorkspace(workspaceId)
      const parent = await client.searchFirstPageId()
      if (!parent) throw Object.assign(new Error('no accessible Notion page to create the report under'), { code: 'NO_PARENT_PAGE' })
      return { notionPageId: null, ownedBlockIds: [], parentPageId: parent }
    },
    async writeReport(args) {
      const client = await clientForWorkspace(args.workspaceId)
      return writeManagedReport(client, { report: args.report, existing: args.existing, parentPageId: args.parentPageId, title: args.title })
    },
    upsertReport: (args) => upsertReport(prisma, args),
    loadVerifiedClaims: (args) => getVerifiedClaimsForRun(prisma, args),
  }
}

const connection = { url: getEnv().REDIS_URL, maxRetriesPerRequest: null }
new Worker<ScanJob>(SCAN_QUEUE, async (job) => runScan(buildDeps(), job.data.scanRunId), { connection })
const snapshotWorker = new Worker<SnapshotJob>(SNAPSHOT_QUEUE, async (job) => runSnapshot(buildSnapshotDeps(), job.data.snapshotRunId), { connection })

// Recovery net: runSnapshot marks the run on a normal throw, but a hard process kill or a BullMQ
// stall bypasses that. BullMQ emits 'failed' for such jobs (here or on a restarted worker) — flip
// the run out of 'running' so it can't stay stuck. Best-effort; never throws out of the handler.
snapshotWorker.on('failed', async (job) => {
  if (!job) return
  try {
    await setSnapshotRunStatus(getPrisma(), { snapshotRunId: job.data.snapshotRunId, status: 'failed', error: 'worker job failed', markFinished: true })
  } catch {
    log.error('snapshot_failed_handler_error', { snapshotRunId: job.data.snapshotRunId })
  }
})

const reportWorker = new Worker<ReportJob>(REPORT_QUEUE, async (job) => runReport(buildReportDeps(), job.data), { connection })

// Recovery net: a hard kill bypasses runReport's own status writes. On 'failed', recover by the
// run's current status — rewriting -> write_failed; running/queued -> write_failed if claims were
// already persisted (D-8: keep verified claims + write-only retry), else failed. Best-effort.
reportWorker.on('failed', async (job) => {
  if (!job) return
  try {
    const prisma = getPrisma()
    const run = await prisma.reportRun.findUnique({ where: { id: job.data.reportRunId }, select: { workspaceId: true, status: true } })
    if (!run) return
    const hasClaims = await hasPersistedClaims(prisma, { workspaceId: run.workspaceId, reportRunId: job.data.reportRunId })
    const next = recoveryStatusFor(run.status, hasClaims)
    if (next) await setReportRunStatus(prisma, { workspaceId: run.workspaceId, reportRunId: job.data.reportRunId, status: next, error: 'worker job failed', markFinished: true })
  } catch {
    log.error('report_failed_handler_error', { reportRunId: job.data.reportRunId })
  }
})
