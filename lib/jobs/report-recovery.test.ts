import { describe, it, expect } from 'vitest'
import { recoveryStatusFor } from './report-recovery'

describe('recoveryStatusFor', () => {
  it('stuck running/queued recovers to failed', () => {
    expect(recoveryStatusFor('running')).toBe('failed')
    expect(recoveryStatusFor('queued')).toBe('failed')
  })
  it('stuck rewriting recovers to write_failed (retry stays available)', () => {
    expect(recoveryStatusFor('rewriting')).toBe('write_failed')
  })
  it('terminal statuses are left as-is (null)', () => {
    expect(recoveryStatusFor('committed')).toBeNull()
    expect(recoveryStatusFor('write_failed')).toBeNull()
    expect(recoveryStatusFor('failed')).toBeNull()
  })
})
