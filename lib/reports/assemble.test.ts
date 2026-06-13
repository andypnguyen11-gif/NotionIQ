// lib/reports/assemble.test.ts
import { describe, it, expect } from 'vitest'
import { renderClaim, assembleReport, FALLBACK_TEXT, SECTION_ORDER } from './assemble'
import type { Fact, VerifiedClaim } from '@/lib/contracts/report'

const sumFact: Fact = { factId: 'f', metricRequest: { metric: 'sum', sourceDatabaseId: 'db1', measureFieldId: 'amt' }, label: 'Sum', value: 120, previousValue: 108, delta: { absolute: 12, relative: 0.111 }, snapshotVersion: 3, computedAt: 't' }
const grpFact: Fact = { factId: 'g', metricRequest: { metric: 'sum', sourceDatabaseId: 'db1', measureFieldId: 'amt', groupByDimensionId: 'reg' }, label: 'By region', value: null, groups: [{ key: 'EMEA', value: 80 }, { key: 'AMER', value: 40 }], snapshotVersion: 3, computedAt: 't' }

function v(partial: Partial<VerifiedClaim> & Pick<VerifiedClaim, 'section' | 'template' | 'assertion'>): VerifiedClaim {
  return { verificationStatus: 'verified', ...partial }
}

describe('assemble', () => {
  it('renders {value} and {delta.relative} from the engine fact', () => {
    const text = renderClaim(v({ section: 'metric', template: 'Total {value}, {delta.relative} vs last.', assertion: { kind: 'value', factId: 'f', expected: 120 }, fact: sumFact }))
    expect(text).toBe('Total 120, +11.1% vs last.')
  })

  it('renders rank {groupKey} and {value} from the winning group', () => {
    const text = renderClaim(v({ section: 'metric', template: '{groupKey} led with {value}.', assertion: { kind: 'rank', factId: 'g', groupKey: 'EMEA', position: 'max' }, fact: grpFact }))
    expect(text).toBe('EMEA led with 80.')
  })

  it('orders sections and sorts by severity (high first) within a section', () => {
    const report = assembleReport([
      v({ section: 'recommendation', template: 'Low rec.', assertion: { kind: 'citation', factIds: ['f'] }, severity: 'low' }),
      v({ section: 'recommendation', template: 'High rec.', assertion: { kind: 'citation', factIds: ['f'] }, severity: 'high' }),
      v({ section: 'summary', template: 'Total {value}.', assertion: { kind: 'value', factId: 'f', expected: 120 }, fact: sumFact }),
    ])
    expect(report.empty).toBe(false)
    expect(report.sections.map((s) => s.section)).toEqual(SECTION_ORDER.filter((s) => s === 'summary' || s === 'recommendation'))
    const rec = report.sections.find((s) => s.section === 'recommendation')!
    expect(rec.items.map((i) => i.text)).toEqual(['High rec.', 'Low rec.'])
  })

  it('drops non-verified claims and emits an honest fallback when none verify', () => {
    const report = assembleReport([
      { section: 'metric', template: 'x', assertion: { kind: 'value', factId: 'f', expected: 1 }, verificationStatus: 'mismatched' },
    ])
    expect(report.empty).toBe(true)
    expect(report.sections).toEqual([{ section: 'summary', items: [{ text: FALLBACK_TEXT }] }])
  })
})
