import { describe, it, expect, vi } from 'vitest'
import { scanDatabases } from './scanner'
import type { ScannedSchema, RawRow } from './notion-client'

function fakeClient() {
  return {
    retrieveDatabase: vi.fn(
      async (id: string): Promise<ScannedSchema> => ({
        notionDatabaseId: id,
        databaseName: `DB ${id}`,
        properties: [{ id: 'p1', name: 'Amount', notionType: 'number' }],
      }),
    ),
    queryDatabaseRows: vi.fn(async (): Promise<{ rows: RawRow[]; nextCursor: string | null }> => ({
      rows: Array.from({ length: 30 }, (_, i) => ({ values: { Amount: String(i) } })),
      nextCursor: null,
    })),
    searchDatabases: vi.fn(),
  }
}

describe('scanDatabases', () => {
  it('returns full schema + a bounded sample per selected database', async () => {
    const client = fakeClient()
    const out = await scanDatabases(client as never, ['db1', 'db2'])
    expect(out.map((d) => d.notionDatabaseId)).toEqual(['db1', 'db2'])
    expect(out[0].properties).toHaveLength(1)
    expect(out[0].sample.length).toBe(20) // MAX_SAMPLE_ROWS
    expect(client.retrieveDatabase).toHaveBeenCalledTimes(2)
  })
})
