import { describe, it, expect } from 'vitest'
import { MetricResultSchema } from './metrics'

describe('metrics contract', () => {
  it('accepts a value result', () => {
    expect(MetricResultSchema.parse({ kind: 'value', value: 1990 })).toEqual({ kind: 'value', value: 1990 })
  })

  it('accepts an unsupported result with a reason', () => {
    const r = { kind: 'unsupported', reason: 'ambiguous measure' }
    expect(MetricResultSchema.parse(r)).toEqual(r)
  })

  it('rejects an unsupported result without a reason', () => {
    expect(MetricResultSchema.safeParse({ kind: 'unsupported' }).success).toBe(false)
  })
})
