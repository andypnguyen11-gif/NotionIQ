// lib/notion/report-writer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { writeManagedReport, SENTINEL_START, SENTINEL_END } from './report-writer'
import type { AssembledReport } from '@/lib/reports/assemble'

const report: AssembledReport = {
  empty: false,
  sections: [{ section: 'summary', items: [{ text: 'Total 120.' }] }],
}

function fakeClient(overrides: Record<string, unknown> = {}) {
  return {
    createPage: vi.fn(async () => 'page_new'),
    appendBlockChildren: vi.fn(async (_id: string, children: unknown[]) => children.map((_c, i) => `b${i}`)),
    deleteBlock: vi.fn(async () => undefined),
    listBlockChildren: vi.fn(async () => ({ blockIds: [], nextCursor: null })),
    ...overrides,
  }
}

describe('report-writer', () => {
  it('creates the managed page on first run and inserts a sentinel-wrapped region', async () => {
    const client = fakeClient()
    const res = await writeManagedReport(client as never, { report, existing: { notionPageId: null, ownedBlockIds: [] }, parentPageId: 'parent_1', title: 'AI Business Review' })
    expect(client.createPage).toHaveBeenCalledWith({ parentPageId: 'parent_1', title: 'AI Business Review' })
    expect(res.notionPageId).toBe('page_new')
    expect(res.ownedBlockIds.length).toBeGreaterThan(0)
    // nothing to delete on first run
    expect(client.deleteBlock).not.toHaveBeenCalled()
    // sentinels are present in the inserted children
    const children = client.appendBlockChildren.mock.calls[0][1] as { type?: string; paragraph?: { rich_text: { text: { content: string } }[] }; heading_2?: { rich_text: { text: { content: string } }[] } }[]
    const texts = children.map((c) => c.paragraph?.rich_text?.[0]?.text?.content)
    expect(texts).toContain(SENTINEL_START)
    expect(texts).toContain(SENTINEL_END)
    // each section emits a heading block (the predictable skeleton users see in Notion)
    const headings = children.filter((c) => c.type === 'heading_2').map((c) => c.heading_2?.rich_text?.[0]?.text?.content)
    expect(headings).toContain('Summary')
  })

  it('inserts BEFORE deleting old owned blocks (live report never blanked)', async () => {
    const order: string[] = []
    const client = fakeClient({
      appendBlockChildren: vi.fn(async (_id: string, c: unknown[]) => { order.push('append'); return (c as unknown[]).map((_x, i) => `n${i}`) }),
      deleteBlock: vi.fn(async (id: string) => { order.push(`delete:${id}`) }),
    })
    const res = await writeManagedReport(client as never, { report, existing: { notionPageId: 'page_1', ownedBlockIds: ['old1', 'old2'] }, parentPageId: 'parent_1', title: 'AI Business Review' })
    expect(client.createPage).not.toHaveBeenCalled()
    expect(order[0]).toBe('append')
    expect(order).toContain('delete:old1')
    expect(order).toContain('delete:old2')
    expect(order.indexOf('append')).toBeLessThan(order.indexOf('delete:old1'))
    // start sentinel + section heading + item + end sentinel = 4 blocks
    expect(res.ownedBlockIds).toEqual(['n0', 'n1', 'n2', 'n3'])
  })

  it('does not delete old blocks if the insert fails (old report stays live)', async () => {
    const client = fakeClient({ appendBlockChildren: vi.fn(async () => { throw new Error('notion 500') }) })
    await expect(writeManagedReport(client as never, { report, existing: { notionPageId: 'page_1', ownedBlockIds: ['old1'] }, parentPageId: 'p', title: 'T' })).rejects.toThrow('notion 500')
    expect(client.deleteBlock).not.toHaveBeenCalled()
  })
})
