import { describe, it, expect } from 'vitest'
import { BOUNDS, boundSample } from './sample-bounds'
import type { RawRow } from './notion-client'

describe('boundSample', () => {
  it('caps rows, cells chars, and reports the constants', () => {
    expect(BOUNDS).toEqual({ MAX_SAMPLE_ROWS: 20, MAX_PROPERTIES: 50, MAX_CELL_CHARS: 200, MAX_OPTION_NAMES: 50 })
    const rows: RawRow[] = Array.from({ length: 25 }, (_, i) => ({ values: { A: 'x'.repeat(300), B: String(i) } }))
    const out = boundSample(rows)
    expect(out.length).toBe(20)
    expect(out[0].values.A.length).toBe(BOUNDS.MAX_CELL_CHARS + 1) // 200 chars + ellipsis
    expect(out[0].values.A.endsWith('…')).toBe(true)
  })
})
