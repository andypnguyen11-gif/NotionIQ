// lib/jobs/report-queue.test.ts
import { describe, it, expect } from 'vitest'
import { REPORT_QUEUE, reportJobPayload } from './report-queue'

describe('report-queue', () => {
  it('uses a dedicated queue name', () => {
    expect(REPORT_QUEUE).toBe('workspace-report')
  })
  it('builds a typed full-run payload by default', () => {
    expect(reportJobPayload('run_1')).toEqual({ reportRunId: 'run_1', mode: 'full' })
  })
  it('builds a write-only payload', () => {
    expect(reportJobPayload('run_1', 'write_only')).toEqual({ reportRunId: 'run_1', mode: 'write_only' })
  })
})
