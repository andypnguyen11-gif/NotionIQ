import { hashSchema } from '@/lib/mapping/schema-hash'
import type { ScannedDatabase } from '@/lib/notion/scanner'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'
import type { DbResult } from '@/lib/data/scan-runs'
import { log } from '@/lib/log'

export interface RunScanDeps {
  loadRun(scanRunId: string): Promise<{ workspaceId: string; selectedDatabaseIds: string[] }>
  scan(workspaceId: string, databaseIds: string[]): Promise<ScannedDatabase[]>
  map(db: ScannedDatabase): Promise<{ proposal: DatabaseMappingProposal; model: string }>
  upsert(args: { workspaceId: string; db: ScannedDatabase; schemaHash: string; proposal: DatabaseMappingProposal; scanRunId: string }): Promise<void>
  finish(scanRunId: string, args: { status: string; results?: DbResult[]; error?: string; mapperModel?: string; propertyCount?: number; sampleRowCount?: number }): Promise<void>
}

export async function runScan(deps: RunScanDeps, scanRunId: string): Promise<void> {
  try {
    const run = await deps.loadRun(scanRunId)
    const dbs = await deps.scan(run.workspaceId, run.selectedDatabaseIds)
    const results: DbResult[] = []
    let model: string | undefined
    let propertyCount = 0
    let sampleRowCount = 0
    for (const db of dbs) {
      propertyCount += db.properties.length
      sampleRowCount += db.sample.length
      try {
        const { proposal, model: m } = await deps.map(db)
        model = m
        await deps.upsert({ workspaceId: run.workspaceId, db, schemaHash: hashSchema(db.properties), proposal, scanRunId })
        results.push({ notionDatabaseId: db.notionDatabaseId, status: 'mapped' })
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'SCAN_ERROR'
        log.error('scan_db_failed', { scanRunId, notionDatabaseId: db.notionDatabaseId, errorCode: code })
        results.push({ notionDatabaseId: db.notionDatabaseId, status: 'failed', errorCode: code })
      }
    }
    await deps.finish(scanRunId, { status: 'proposed', results, mapperModel: model, propertyCount, sampleRowCount })
  } catch {
    log.error('scan_run_failed', { scanRunId })
    await deps.finish(scanRunId, { status: 'failed', error: 'scan run failed' })
  }
}
