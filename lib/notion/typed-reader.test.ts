import { describe, it, expect, vi } from 'vitest'
import { collectTypedRows } from './typed-reader'

describe('collectTypedRows', () => {
  it('paginates through every cursor and concatenates all rows', async () => {
    const queryDatabaseRowsTyped = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ notionPageId: 'a', values: {} }], nextCursor: 'c2' })
      .mockResolvedValueOnce({ rows: [{ notionPageId: 'b', values: {} }], nextCursor: null })
    const rows = await collectTypedRows({ queryDatabaseRowsTyped } as never, 'db1')
    expect(rows.map((r) => r.notionPageId)).toEqual(['a', 'b'])
    expect(queryDatabaseRowsTyped).toHaveBeenNthCalledWith(1, 'db1', { cursor: undefined })
    expect(queryDatabaseRowsTyped).toHaveBeenNthCalledWith(2, 'db1', { cursor: 'c2' })
  })
})
