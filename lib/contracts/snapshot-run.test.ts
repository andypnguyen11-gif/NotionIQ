import { describe, it, expect } from 'vitest'
import { SnapshotRunStatusSchema, SnapshotRunResultsSchema } from './snapshot-run'

describe('snapshot-run contract', () => {
  it('accepts the five run statuses', () => {
    for (const s of ['queued', 'running', 'committed', 'partial', 'failed']) {
      expect(SnapshotRunStatusSchema.parse(s)).toBe(s)
    }
  })

  it('rejects an unknown status', () => {
    expect(SnapshotRunStatusSchema.safeParse('done').success).toBe(false)
  })

  it('validates per-database results', () => {
    const results = [
      { sourceDatabaseId: 'db1', status: 'ingested', rowCount: 42 },
      { sourceDatabaseId: 'db2', status: 'failed', error: 'NOTION_ERROR' },
    ]
    expect(SnapshotRunResultsSchema.parse(results)).toEqual(results)
  })
})
