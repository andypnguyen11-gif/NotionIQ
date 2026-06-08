import { describe, it, expect, vi } from 'vitest'
import { createNotionClient } from './notion-client'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('notion-client', () => {
  const base = { token: 'tok', rateLimiter: { acquire: async () => {} } }

  it('searchDatabases returns only databases with minimal metadata', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        results: [
          { object: 'database', id: 'db1', title: [{ plain_text: 'Sales' }], icon: { type: 'emoji', emoji: '📊' }, last_edited_time: '2026-01-01T00:00:00Z' },
        ],
        has_more: false,
        next_cursor: null,
      }),
    )
    const client = createNotionClient({ ...base, fetchImpl })
    const { databases, nextCursor } = await client.searchDatabases({})
    expect(databases).toEqual([
      { id: 'db1', title: 'Sales', icon: '📊', lastEditedTime: '2026-01-01T00:00:00Z' },
    ])
    expect(nextCursor).toBeNull()
    const [, init] = fetchImpl.mock.calls[0]
    expect((init?.headers as Record<string, string>)['Notion-Version']).toBe('2022-06-28')
    expect(JSON.parse(init?.body as string).filter).toEqual({ property: 'object', value: 'database' })
  })

  it('retrieveDatabase maps properties incl. full option sets and relation target', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        id: 'db1',
        title: [{ plain_text: 'Sales' }],
        properties: {
          Stage: { id: 'p1', type: 'status', status: { options: [{ name: 'Lead' }, { name: 'Won' }] } },
          Amount: { id: 'p2', type: 'number', number: {} },
          Account: { id: 'p3', type: 'relation', relation: { database_id: 'dbX' } },
        },
      }),
    )
    const client = createNotionClient({ ...base, fetchImpl })
    const schema = await client.retrieveDatabase('db1')
    expect(schema.databaseName).toBe('Sales')
    expect(schema.properties).toEqual(
      expect.arrayContaining([
        { id: 'p1', name: 'Stage', notionType: 'status', optionNames: ['Lead', 'Won'] },
        { id: 'p2', name: 'Amount', notionType: 'number' },
        { id: 'p3', name: 'Account', notionType: 'relation', relationTargetId: 'dbX' },
      ]),
    )
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 401 }))
    const client = createNotionClient({ ...base, fetchImpl })
    await expect(client.searchDatabases({})).rejects.toThrow(/401/)
  })
})
