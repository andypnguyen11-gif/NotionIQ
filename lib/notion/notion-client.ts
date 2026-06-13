import { z } from 'zod'
import type { RateLimiter } from './rate-limiter'
import { withBackoff } from './rate-limiter'
import type { TypedRow, TypedValue } from '@/lib/contracts/normalized'

const NOTION_VERSION = '2022-06-28'
const API = 'https://api.notion.com/v1'

export interface DatabaseListItem { id: string; title: string; icon: string | null; lastEditedTime: string }
export interface ScannedProperty { id: string; name: string; notionType: string; optionNames?: string[]; relationTargetId?: string }
export interface ScannedSchema { notionDatabaseId: string; databaseName: string; properties: ScannedProperty[] }
export interface RawRow { values: Record<string, string> } // property name -> stringified cell

const titleText = (t: unknown) =>
  Array.isArray(t) ? t.map((x: { plain_text?: string }) => x.plain_text ?? '').join('') : ''

const SearchResp = z.object({
  results: z.array(z.record(z.string(), z.unknown())),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
})

export function createNotionClient(opts: {
  token: string
  rateLimiter: RateLimiter
  fetchImpl?: typeof fetch
}) {
  const doFetch = opts.fetchImpl ?? fetch
  // Single network path for all three reads: rate-limit, send with auth + version headers,
  // throw on non-ok (status attached so withBackoff can retry 429/5xx). GET omits the body.
  async function call(args: { method: 'GET' | 'POST' | 'DELETE'; path: string; body?: unknown }): Promise<unknown> {
    await opts.rateLimiter.acquire()
    return withBackoff(
      async () => {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${opts.token}`,
          'Notion-Version': NOTION_VERSION,
        }
        if (args.method === 'POST') headers['Content-Type'] = 'application/json'
        const res = await doFetch(`${API}${args.path}`, {
          method: args.method,
          headers,
          body: args.method === 'POST' ? JSON.stringify(args.body) : undefined,
        })
        if (!res.ok) throw Object.assign(new Error(`Notion ${args.path} failed: ${res.status}`), { status: res.status })
        return res.json()
      },
      { retries: 3, baseMs: 400 },
    )
  }

  return {
    async searchDatabases(args: { cursor?: string }): Promise<{ databases: DatabaseListItem[]; nextCursor: string | null }> {
      const raw = SearchResp.parse(
        await call({ method: 'POST', path: '/search', body: { filter: { property: 'object', value: 'database' }, start_cursor: args.cursor, page_size: 100 } }),
      )
      const databases = raw.results.map((r) => {
        const rec = r as { id: string; title?: unknown; icon?: { emoji?: string }; last_edited_time?: string }
        return { id: rec.id, title: titleText(rec.title), icon: rec.icon?.emoji ?? null, lastEditedTime: rec.last_edited_time ?? '' }
      })
      return { databases, nextCursor: raw.next_cursor }
    },

    async retrieveDatabase(databaseId: string): Promise<ScannedSchema> {
      const raw = (await call({ method: 'GET', path: `/databases/${databaseId}` })) as {
        id: string
        title?: unknown
        properties: Record<string, Record<string, unknown>>
      }

      const properties: ScannedProperty[] = Object.entries(raw.properties).map(([name, def]) => {
        const type = def.type as string
        const prop: ScannedProperty = { id: def.id as string, name, notionType: type }
        const opt = (def[type] as { options?: { name: string }[] } | undefined)?.options
        if (opt) prop.optionNames = opt.map((o) => o.name)
        const rel = (def[type] as { database_id?: string } | undefined)?.database_id
        if (rel) prop.relationTargetId = rel
        return prop
      })
      return { notionDatabaseId: raw.id, databaseName: titleText(raw.title), properties }
    },

    async queryDatabaseRows(databaseId: string, args: { cursor?: string; pageSize?: number }): Promise<{ rows: RawRow[]; nextCursor: string | null }> {
      const raw = (await call({ method: 'POST', path: `/databases/${databaseId}/query`, body: { start_cursor: args.cursor, page_size: args.pageSize ?? 20 } })) as {
        results: { properties: Record<string, unknown> }[]
        next_cursor: string | null
      }
      const rows: RawRow[] = raw.results.map((row) => ({ values: stringifyRow(row.properties) }))
      return { rows, nextCursor: raw.next_cursor }
    },

    async queryDatabaseRowsTyped(databaseId: string, args: { cursor?: string; pageSize?: number }): Promise<{ rows: TypedRow[]; nextCursor: string | null }> {
      const raw = (await call({ method: 'POST', path: `/databases/${databaseId}/query`, body: { start_cursor: args.cursor, page_size: args.pageSize ?? 100 } })) as {
        results: { id: string; properties: Record<string, Record<string, unknown>> }[]
        next_cursor: string | null
      }
      const rows: TypedRow[] = raw.results.map((row) => {
        const values: Record<string, TypedValue> = {}
        for (const def of Object.values(row.properties)) values[def.id as string] = toTypedValue(def)
        return { notionPageId: row.id, values }
      })
      return { rows, nextCursor: raw.next_cursor }
    },

    async createPage(args: { parentPageId: string; title: string }): Promise<string> {
      const raw = (await call({
        method: 'POST',
        path: '/pages',
        body: {
          parent: { page_id: args.parentPageId },
          properties: { title: { title: [{ type: 'text', text: { content: args.title } }] } },
        },
      })) as { id: string }
      return raw.id
    },

    async appendBlockChildren(blockId: string, children: unknown[]): Promise<string[]> {
      const raw = (await call({ method: 'POST', path: `/blocks/${blockId}/children`, body: { children } })) as { results: { id: string }[] }
      return raw.results.map((b) => b.id)
    },

    async listBlockChildren(blockId: string, args: { cursor?: string }): Promise<{ blockIds: string[]; nextCursor: string | null }> {
      const qs = args.cursor ? `?start_cursor=${encodeURIComponent(args.cursor)}` : ''
      const raw = (await call({ method: 'GET', path: `/blocks/${blockId}/children${qs}` })) as { results: { id: string }[]; next_cursor: string | null }
      return { blockIds: raw.results.map((b) => b.id), nextCursor: raw.next_cursor }
    },

    async deleteBlock(blockId: string): Promise<void> {
      await call({ method: 'DELETE', path: `/blocks/${blockId}` })
    },

    // First page the integration can access — the default parent for the managed report page on
    // first run. Returns null if the integration has no page access (caller surfaces a clear error).
    async searchFirstPageId(): Promise<string | null> {
      const raw = (await call({ method: 'POST', path: '/search', body: { filter: { property: 'object', value: 'page' }, page_size: 1 } })) as { results: { id: string }[] }
      return raw.results[0]?.id ?? null
    },
  }
}

// Best-effort flatten of a Notion row's property values to short strings. Used only to
// build a transient mapper sample — never persisted.
function stringifyRow(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, def] of Object.entries(props)) {
    const d = def as { type?: string; [k: string]: unknown }
    const v = d.type ? d[d.type] : undefined
    out[name] = renderValue(v)
  }
  return out
}

function renderValue(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map((x) => renderValue(x)).filter(Boolean).join(', ')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('name' in o) return String(o.name)
    if ('plain_text' in o) return String(o.plain_text)
    if ('start' in o) return String(o.start)
    return ''
  }
  return String(v)
}

// Map one Notion page-property object to a TypedValue. Unknown/unsupported types → empty
// (so coverage gaps are visible as empties rather than crashing — see spec §14).
function toTypedValue(def: Record<string, unknown>): TypedValue {
  const type = def.type as string
  const v = def[type]
  switch (type) {
    case 'number':
      return typeof v === 'number' ? { kind: 'number', value: v } : { kind: 'empty' }
    case 'title':
    case 'rich_text':
      return { kind: 'text', value: plainText(v) }
    case 'select':
    case 'status': {
      const name = (v as { name?: string } | null)?.name
      return name ? { kind: 'text', value: name } : { kind: 'empty' }
    }
    case 'multi_select':
      return { kind: 'list', value: ((v as { name: string }[]) ?? []).map((o) => o.name) }
    case 'relation':
    case 'people':
      return { kind: 'list', value: ((v as { id: string }[]) ?? []).map((o) => o.id) }
    case 'date': {
      const start = (v as { start?: string } | null)?.start
      const iso = start ? toUtcIso(start) : null
      return iso ? { kind: 'date', value: iso } : { kind: 'empty' }
    }
    default:
      return { kind: 'empty' }
  }
}

function plainText(v: unknown): string {
  return Array.isArray(v) ? v.map((x: { plain_text?: string }) => x.plain_text ?? '').join('') : ''
}

// Widen date-only to midnight UTC; convert datetimes to UTC. Invalid → null.
function toUtcIso(input: string): string | null {
  const d = new Date(input)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
