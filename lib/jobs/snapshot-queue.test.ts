import { describe, it, expect } from 'vitest'
import { SNAPSHOT_QUEUE, snapshotJobPayload } from './snapshot-queue'

describe('snapshot-queue', () => {
  it('uses a dedicated queue name distinct from the scan queue', () => {
    expect(SNAPSHOT_QUEUE).toBe('workspace-snapshot')
  })
  it('builds a typed job payload', () => {
    expect(snapshotJobPayload('run_1')).toEqual({ snapshotRunId: 'run_1' })
  })
})
