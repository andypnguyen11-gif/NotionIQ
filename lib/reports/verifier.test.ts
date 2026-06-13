// lib/reports/verifier.test.ts
import { describe, it, expect } from 'vitest'
import { verifyClaims, ALLOWED_PLACEHOLDERS } from './verifier'
import type { Fact, FactSheet, InsightClaim, MetricRequestSpec } from '@/lib/contracts/report'

const scalarFact: Fact = {
  factId: 'f_sum', metricRequest: { metric: 'sum', sourceDatabaseId: 'db1', measureFieldId: 'amt' },
  label: 'Sum', value: 120, previousValue: 108, delta: { absolute: 12, relative: 0.111 },
  snapshotVersion: 3, computedAt: 't',
}
const groupFact: Fact = {
  factId: 'f_grp', metricRequest: { metric: 'sum', sourceDatabaseId: 'db1', measureFieldId: 'amt', groupByDimensionId: 'reg' },
  label: 'Sum by Region', value: null, groups: [{ key: 'EMEA', value: 80 }, { key: 'AMER', value: 40 }],
  snapshotVersion: 3, computedAt: 't',
}
const nullFact: Fact = {
  factId: 'f_null', metricRequest: { metric: 'average', sourceDatabaseId: 'db1', measureFieldId: 'amt' },
  label: 'Average', value: null, snapshotVersion: 3, computedAt: 't',
}
const sheet: FactSheet = { snapshotVersion: 3, generatedAt: 't', facts: [scalarFact, groupFact, nullFact] }
const recompute = (req: MetricRequestSpec): Fact => {
  if (req.groupByDimensionId) return groupFact
  if (req.metric === 'average') return nullFact
  return scalarFact
}
const verify = (claims: InsightClaim[]) => verifyClaims(claims, sheet, recompute)

describe('verifier', () => {
  it('verifies a value claim within tolerance', () => {
    const [v] = verify([{ section: 'metric', template: 'Total {value}.', assertion: { kind: 'value', factId: 'f_sum', expected: 120 } }])
    expect(v.verificationStatus).toBe('verified')
    expect(v.fact?.value).toBe(120)
  })

  it('marks a value claim mismatched when the number is wrong', () => {
    const [v] = verify([{ section: 'metric', template: 'Total {value}.', assertion: { kind: 'value', factId: 'f_sum', expected: 999 } }])
    expect(v.verificationStatus).toBe('mismatched')
  })

  it('verifies a trend claim by direction', () => {
    const [v] = verify([{ section: 'trend', template: 'Up {delta.relative}.', assertion: { kind: 'trend', factId: 'f_sum', direction: 'up' } }])
    expect(v.verificationStatus).toBe('verified')
  })

  it('rejects a trend whose asserted direction is wrong', () => {
    const [v] = verify([{ section: 'trend', template: 'Down {delta.relative}.', assertion: { kind: 'trend', factId: 'f_sum', direction: 'down' } }])
    expect(v.verificationStatus).toBe('mismatched')
  })

  it('verifies a rank claim when the group is the max', () => {
    const [v] = verify([{ section: 'metric', template: '{groupKey} led with {value}.', assertion: { kind: 'rank', factId: 'f_grp', groupKey: 'EMEA', position: 'max' } }])
    expect(v.verificationStatus).toBe('verified')
  })

  it('rejects a rank claim naming a non-max group', () => {
    const [v] = verify([{ section: 'metric', template: '{groupKey} led.', assertion: { kind: 'rank', factId: 'f_grp', groupKey: 'AMER', position: 'max' } }])
    expect(v.verificationStatus).toBe('mismatched')
  })

  it('marks unsupported when the factId is unknown', () => {
    const [v] = verify([{ section: 'metric', template: 'X {value}.', assertion: { kind: 'value', factId: 'nope', expected: 1 } }])
    expect(v.verificationStatus).toBe('unsupported')
  })

  it('marks unsupported for a null-valued fact in a value claim', () => {
    const [v] = verify([{ section: 'metric', template: 'Avg {value}.', assertion: { kind: 'value', factId: 'f_null', expected: 0 } }])
    expect(v.verificationStatus).toBe('unsupported')
  })

  it('rejects a template with an unknown placeholder', () => {
    const [v] = verify([{ section: 'metric', template: 'Total {secret}.', assertion: { kind: 'value', factId: 'f_sum', expected: 120 } }])
    expect(v.verificationStatus).toBe('mismatched')
    expect(v.reason).toMatch(/placeholder/i)
  })

  it('rejects a citation template that contains a numeric placeholder', () => {
    const [v] = verify([{ section: 'recommendation', template: 'Do X, see {value}.', assertion: { kind: 'citation', factIds: ['f_sum'] } }])
    expect(v.verificationStatus).toBe('mismatched')
  })

  it('verifies a citation when at least one cited fact is verifiable, unevidenced when none', () => {
    const [ok] = verify([{ section: 'recommendation', template: 'Raise prices.', assertion: { kind: 'citation', factIds: ['f_sum'] } }])
    expect(ok.verificationStatus).toBe('verified')
    const [bad] = verify([{ section: 'recommendation', template: 'Raise prices.', assertion: { kind: 'citation', factIds: ['nope'] } }])
    expect(bad.verificationStatus).toBe('unevidenced')
  })

  it('exposes the allowed placeholder whitelist', () => {
    expect(ALLOWED_PLACEHOLDERS).toEqual(['value', 'previousValue', 'delta.absolute', 'delta.relative', 'groupKey'])
  })
})
