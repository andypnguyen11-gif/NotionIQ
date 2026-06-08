import { describe, it, expect } from 'vitest'
import { candidateRole } from './candidate-rules'

describe('candidateRole', () => {
  it.each([
    ['title', 'title'],
    ['date', 'date'],
    ['created_time', 'date'],
    ['last_edited_time', 'date'],
    ['number', 'measure'],
    ['select', 'dimension'],
    ['multi_select', 'dimension'],
    ['relation', 'dimension'],
    ['people', 'dimension'],
    ['status', 'status'],
    ['rich_text', 'ignore'],
    ['checkbox', 'ignore'],
    ['url', 'ignore'],
    ['files', 'ignore'],
  ])('maps %s -> %s', (notionType, expected) => {
    expect(candidateRole({ notionType })).toBe(expected)
  })

  it('maps a number-returning formula to measure', () => {
    expect(candidateRole({ notionType: 'formula', formulaResultType: 'number' })).toBe('measure')
  })

  it('maps a number rollup to measure', () => {
    expect(candidateRole({ notionType: 'rollup', rollupResultType: 'number' })).toBe('measure')
  })

  it('maps a non-number formula to ignore', () => {
    expect(candidateRole({ notionType: 'formula', formulaResultType: 'string' })).toBe('ignore')
  })
})
