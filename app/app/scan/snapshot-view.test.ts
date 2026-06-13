import { describe, it, expect } from 'vitest'
import { snapshotCtaLabel, snapshotProgressLabel, canBuildSnapshot } from './snapshot-view'

describe('snapshot-view', () => {
  it('labels the CTA build before the first snapshot, refresh after', () => {
    expect(snapshotCtaLabel(false)).toBe('Build data snapshot')
    expect(snapshotCtaLabel(true)).toBe('Refresh data snapshot')
  })

  it('enables building only when all required mappings are approved', () => {
    expect(canBuildSnapshot({ allApproved: true, building: false })).toBe(true)
    expect(canBuildSnapshot({ allApproved: false, building: false })).toBe(false)
    expect(canBuildSnapshot({ allApproved: true, building: true })).toBe(false)
  })

  it('summarizes per-database progress', () => {
    expect(snapshotProgressLabel({ status: 'running', results: [] })).toBe('Building snapshot…')
    expect(snapshotProgressLabel({ status: 'committed', results: [{ sourceDatabaseId: 'db1', status: 'ingested', rowCount: 5 }] })).toBe('Snapshot built — 1 database, 5 rows')
    expect(snapshotProgressLabel({ status: 'partial', results: [{ sourceDatabaseId: 'a', status: 'ingested', rowCount: 2 }, { sourceDatabaseId: 'b', status: 'failed' }] })).toBe('1 ingested, 1 failed — snapshot not updated')
    expect(snapshotProgressLabel({ status: 'failed', results: [] })).toBe('Snapshot build failed — previous data unchanged')
  })
})
