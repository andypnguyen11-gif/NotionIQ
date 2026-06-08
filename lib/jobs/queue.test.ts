import { describe, it, expect } from 'vitest'
import { scanJobPayload, SCAN_QUEUE } from './queue'

describe('queue', () => {
  it('names the queue and builds a minimal job payload', () => {
    expect(SCAN_QUEUE).toBe('workspace-scan')
    expect(scanJobPayload('run_1')).toEqual({ scanRunId: 'run_1' })
  })
})
