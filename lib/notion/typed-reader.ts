import type { createNotionClient } from './notion-client'
import type { TypedRow } from '@/lib/contracts/normalized'

type NotionClient = ReturnType<typeof createNotionClient>

// Full pull: page through a database to completion via the rate-limited typed reader.
export async function collectTypedRows(client: NotionClient, databaseId: string): Promise<TypedRow[]> {
  const all: TypedRow[] = []
  let cursor: string | undefined
  do {
    const { rows, nextCursor } = await client.queryDatabaseRowsTyped(databaseId, { cursor })
    all.push(...rows)
    cursor = nextCursor ?? undefined
  } while (cursor)
  return all
}
