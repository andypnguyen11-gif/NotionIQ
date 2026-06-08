import { describe, it, expect } from 'vitest'
import { notionStatusBanner } from './notion-status'

describe('notionStatusBanner', () => {
  it('returns a success banner for connected', () => {
    expect(notionStatusBanner('connected')).toEqual({ tone: 'success', message: 'Notion connected.' })
  })
  it('returns an error-tone banner for denied, invalid, and error', () => {
    expect(notionStatusBanner('denied')?.tone).toBe('error')
    expect(notionStatusBanner('invalid')?.tone).toBe('error')
    expect(notionStatusBanner('error')?.tone).toBe('error')
  })
  it('returns distinct messages per failure status', () => {
    const msgs = new Set([
      notionStatusBanner('denied')?.message,
      notionStatusBanner('invalid')?.message,
      notionStatusBanner('error')?.message,
    ])
    expect(msgs.size).toBe(3)
  })
  it('returns null for unknown or absent status', () => {
    expect(notionStatusBanner(undefined)).toBeNull()
    expect(notionStatusBanner('bogus')).toBeNull()
  })
})
