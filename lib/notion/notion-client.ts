import { z } from 'zod'
import type { RateLimiter } from './rate-limiter'
import { withBackoff } from './rate-limiter'

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
  async function call(path: string, body: unknown): Promise<unknown> {
    await opts.rateLimiter.acquire()
    return withBackoff(
      async () => {
        const res = await doFetch(`${API}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.token}`,
            'Content-Type': 'application/json',
            'Notion-Version': NOTION_VERSION,
          },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw Object.assign(new Error(`Notion ${path} failed: ${res.status}`), { status: res.status })
        return res.json()
      },
      { retries: 3, baseMs: 400 },
    )
  }

  return {
    async searchDatabases(args: { cursor?: string }): Promise<{ databases: DatabaseListItem[]; nextCursor: string | null }> {
      const raw = SearchResp.parse(
        await call('/search', { filter: { property: 'object', value: 'database' }, start_cursor: args.cursor, page_size: 100 }),
      )
      const databases = raw.results.map((r) => {
        const rec = r as { id: string; title?: unknown; icon?: { emoji?: string }; last_edited_time?: string }
        return { id: rec.id, title: titleText(rec.title), icon: rec.icon?.emoji ?? null, lastEditedTime: rec.last_edited_time ?? '' }
      })
      return { databases, nextCursor: raw.next_cursor }
    },

    async retrieveDatabase(databaseId: string): Promise<ScannedSchema> {
      await opts.rateLimiter.acquire()
      const raw = (await withBackoff(
        async () => {
          const res = await doFetch(`${API}/databases/${databaseId}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${opts.token}`, 'Notion-Version': NOTION_VERSION },
          })
          if (!res.ok) throw Object.assign(new Error(`Notion retrieveDatabase failed: ${res.status}`), { status: res.status })
          return res.json()
        },
        { retries: 3, baseMs: 400 },
      )) as { id: string; title?: unknown; properties: Record<string, Record<string, unknown>> }

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
      const raw = (await call(`/databases/${databaseId}/query`, { start_cursor: args.cursor, page_size: args.pageSize ?? 20 })) as {
        results: { properties: Record<string, unknown> }[]
        next_cursor: string | null
      }
      const rows: RawRow[] = raw.results.map((row) => ({ values: stringifyRow(row.properties) }))
      return { rows, nextCursor: raw.next_cursor }
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
