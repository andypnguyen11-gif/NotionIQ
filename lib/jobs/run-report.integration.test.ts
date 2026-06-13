// lib/jobs/run-report.integration.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runReport, type RunReportDeps } from './run-report'
import { buildManagedBlocks } from '@/lib/notion/report-writer'
import type { DatabaseMappingProposal } from '@/lib/contracts/mapping'
import type { MetricRecord } from '@/lib/contracts/normalized'
import type { VerifiedClaim } from '@/lib/contracts/report'

const mapping: DatabaseMappingProposal = {
  classification: 'sales', occurredAtPropertyId: null,
  fields: [
    { notionPropertyId: 'amt', name: 'Amount', notionType: 'number', candidateRole: 'measure', role: 'measure', confidence: 1, rationale: '' },
    { notionPropertyId: 'reg', name: 'Region', notionType: 'select', candidateRole: 'dimension', role: 'dimension', confidence: 1, rationale: '' },
  ],
  modelVersion: 'm', promptVersion: 'p',
}
const rec = (amt: number, reg: string): MetricRecord => ({ occurredAt: null, mappedFields: { measures: { amt: { name: 'Amount', value: amt } }, dimensions: { reg: { name: 'Region', value: reg } }, status: {} } })

describe('runReport integration (real pure pipeline)', () => {
  it('verifies a rank claim end-to-end and produces a well-formed Notion payload', async () => {
    let persisted: VerifiedClaim[] = []
    let writtenReport: import('@/lib/reports/assemble').AssembledReport | null = null
    const deps: RunReportDeps = {
      clock: () => '2026-06-12T00:00:00.000Z',
      loadRun: async () => ({ workspaceId: 'ws_1', currentVersion: 3, runSnapshotVersion: 3 }),
      loadFactInputs: async () => ({ dbs: [{ sourceDatabaseId: 'db1', mapping, current: [rec(80, 'EMEA'), rec(40, 'AMER')], previous: [] }], context: { databases: [{ sourceDatabaseId: 'db1', classification: 'sales' }] } }),
      draft: async () => ({
        claims: [{ section: 'metric', template: '{groupKey} led with {value}.', assertion: { kind: 'rank', factId: '3::db1::sum::amt::reg::-', groupKey: 'EMEA', position: 'max' } }],
        inputTokens: 1, outputTokens: 1, model: 'm', promptVersion: 'insight-v1',
      }),
      repair: async () => { throw new Error('should not repair') },
      persistClaims: async (a) => { persisted = a.claims },
      setStatus: vi.fn(async () => undefined),
      loadReportPointer: async () => ({ notionPageId: null, ownedBlockIds: [], parentPageId: 'parent_1' }),
      writeReport: async (a) => { writtenReport = a.report; return { notionPageId: 'page_1', ownedBlockIds: ['b0'] } },
      upsertReport: vi.fn(async () => undefined),
      loadVerifiedClaims: async () => [],
    }
    await runReport(deps, { reportRunId: 'run_1', mode: 'full' })
    const verified = persisted.filter((c) => c.verificationStatus === 'verified')
    expect(verified).toHaveLength(1)
    expect(verified[0].renderedText).toBe('EMEA led with 80.')
    const blocks = buildManagedBlocks(writtenReport!)
    expect(blocks.length).toBeGreaterThan(2) // sentinels + heading + item
  })
})
