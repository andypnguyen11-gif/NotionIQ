import { describe, it, expect } from 'vitest'
import { recoveryStatusFor } from './report-recovery'

describe('recoveryStatusFor', () => {
  it('stuck running/queued with no persisted claims recovers to failed', () => {
    expect(recoveryStatusFor('running', false)).toBe('failed')
    expect(recoveryStatusFor('queued', false)).toBe('failed')
  })
  it('stuck running/queued with persisted claims recovers to write_failed (D-8: claims intact, retry available)', () => {
    expect(recoveryStatusFor('running', true)).toBe('write_failed')
    expect(recoveryStatusFor('queued', true)).toBe('write_failed')
  })
  it('stuck rewriting recovers to write_failed regardless of claim flag (retry stays available)', () => {
    expect(recoveryStatusFor('rewriting', false)).toBe('write_failed')
    expect(recoveryStatusFor('rewriting', true)).toBe('write_failed')
  })
  it('terminal statuses are left as-is (null) regardless of claim flag', () => {
    expect(recoveryStatusFor('committed', false)).toBeNull()
    expect(recoveryStatusFor('committed', true)).toBeNull()
    expect(recoveryStatusFor('write_failed', false)).toBeNull()
    expect(recoveryStatusFor('write_failed', true)).toBeNull()
    expect(recoveryStatusFor('failed', false)).toBeNull()
    expect(recoveryStatusFor('failed', true)).toBeNull()
  })
})
