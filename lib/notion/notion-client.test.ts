import { describe, it, expect, vi } from 'vitest'
import { createNotionClient } from './notion-client'
import { createRateLimiter } from './rate-limiter'

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

  it('queryDatabaseRowsTyped maps native types to typed values keyed by property id', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            id: 'pg1',
            properties: {
              Amount: { id: 'p1', type: 'number', number: 1990 },
              Region: { id: 'p2', type: 'select', select: { name: 'EMEA' } },
              Tags: { id: 'p3', type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] },
              Closed: { id: 'p4', type: 'date', date: { start: '2026-06-12' } },
              Empty: { id: 'p5', type: 'number', number: null },
            },
          },
        ],
        next_cursor: null,
      }),
    )
    const client = createNotionClient({ ...base, fetchImpl })
    const { rows, nextCursor } = await client.queryDatabaseRowsTyped('db1', {})
    expect(nextCursor).toBeNull()
    expect(rows[0].notionPageId).toBe('pg1')
    expect(rows[0].values).toEqual({
      p1: { kind: 'number', value: 1990 },
      p2: { kind: 'text', value: 'EMEA' },
      p3: { kind: 'list', value: ['a', 'b'] },
      p4: { kind: 'date', value: '2026-06-12T00:00:00.000Z' },
      p5: { kind: 'empty' },
    })
  })
})

function okFetch(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

describe('notion client write methods', () => {
  it('createPage posts a child page and returns its id', async () => {
    const fetchImpl = okFetch({ id: 'page_1' })
    const client = createNotionClient({ token: 't', rateLimiter: createRateLimiter({ ratePerSec: 50 }), fetchImpl })
    const id = await client.createPage({ parentPageId: 'parent_1', title: 'AI Business Review' })
    expect(id).toBe('page_1')
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toMatch(/\/pages$/)
    expect(JSON.parse((init as RequestInit).body as string).parent).toEqual({ page_id: 'parent_1' })
  })

  it('appendBlockChildren returns the created block ids in order', async () => {
    const fetchImpl = okFetch({ results: [{ id: 'b1' }, { id: 'b2' }] })
    const client = createNotionClient({ token: 't', rateLimiter: createRateLimiter({ ratePerSec: 50 }), fetchImpl })
    const ids = await client.appendBlockChildren('page_1', [{ type: 'paragraph' } as never])
    expect(ids).toEqual(['b1', 'b2'])
  })

  it('listBlockChildren returns child ids', async () => {
    const fetchImpl = okFetch({ results: [{ id: 'b1' }, { id: 'b2' }], next_cursor: null })
    const client = createNotionClient({ token: 't', rateLimiter: createRateLimiter({ ratePerSec: 50 }), fetchImpl })
    const res = await client.listBlockChildren('page_1', {})
    expect(res.blockIds).toEqual(['b1', 'b2'])
  })

  it('deleteBlock issues a DELETE for the block', async () => {
    const fetchImpl = okFetch({ id: 'b1', archived: true })
    const client = createNotionClient({ token: 't', rateLimiter: createRateLimiter({ ratePerSec: 50 }), fetchImpl })
    await client.deleteBlock('b1')
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toMatch(/\/blocks\/b1$/)
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('searchFirstPageId returns the id of the first accessible page, or null', async () => {
    const withPage = okFetch({ results: [{ id: 'pg_1', object: 'page' }], has_more: false, next_cursor: null })
    const c1 = createNotionClient({ token: 't', rateLimiter: createRateLimiter({ ratePerSec: 50 }), fetchImpl: withPage })
    expect(await c1.searchFirstPageId()).toBe('pg_1')
    const empty = okFetch({ results: [], has_more: false, next_cursor: null })
    const c2 = createNotionClient({ token: 't', rateLimiter: createRateLimiter({ ratePerSec: 50 }), fetchImpl: empty })
    expect(await c2.searchFirstPageId()).toBeNull()
  })
})
