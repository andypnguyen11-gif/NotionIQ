import type { createNotionClient, ScannedProperty, RawRow } from './notion-client'
import { boundSample, BOUNDS } from './sample-bounds'

export interface ScannedDatabase {
  notionDatabaseId: string
  databaseName: string
  properties: ScannedProperty[]
  sample: RawRow[]
}

type NotionClient = ReturnType<typeof createNotionClient>

// Read each selected database's full schema plus one bounded page of rows for the mapper.
// Raw rows never leave this layer except as the transient sample passed to the mapper.
export async function scanDatabases(
  client: NotionClient,
  databaseIds: string[],
): Promise<ScannedDatabase[]> {
  const out: ScannedDatabase[] = []
  for (const id of databaseIds) {
    const schema = await client.retrieveDatabase(id)
    const { rows } = await client.queryDatabaseRows(id, { pageSize: BOUNDS.MAX_SAMPLE_ROWS })
    out.push({
      notionDatabaseId: schema.notionDatabaseId,
      databaseName: schema.databaseName,
      properties: schema.properties,
      sample: boundSample(rows),
    })
  }
  return out
}
