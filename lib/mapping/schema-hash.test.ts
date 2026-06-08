import { describe, it, expect } from 'vitest'
import { hashSchema } from './schema-hash'
import type { ScannedProperty } from '@/lib/notion/notion-client'

const props: ScannedProperty[] = [
  { id: 'p1', name: 'Stage', notionType: 'status', optionNames: ['Lead', 'Won'] },
  { id: 'p2', name: 'Amount', notionType: 'number' },
]

describe('hashSchema', () => {
  it('is stable regardless of property order', () => {
    expect(hashSchema(props)).toBe(hashSchema([props[1], props[0]]))
  })

  it('changes when a type changes', () => {
    expect(hashSchema(props)).not.toBe(
      hashSchema([{ ...props[0] }, { ...props[1], notionType: 'rich_text' }]),
    )
  })

  it('changes when an option beyond a display cap is added (full option set hashed)', () => {
    const big = Array.from({ length: 60 }, (_, i) => `opt${i}`)
    const a = hashSchema([{ id: 'p1', name: 'Stage', notionType: 'status', optionNames: big }])
    const b = hashSchema([{ id: 'p1', name: 'Stage', notionType: 'status', optionNames: [...big, 'opt60'] }])
    expect(a).not.toBe(b)
  })
})
