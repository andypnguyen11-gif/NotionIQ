import { createHash } from 'node:crypto'
import type { ScannedProperty } from '@/lib/notion/notion-client'

// Hash the FULL untruncated schema (all properties + complete option sets) so a change
// beyond any display/mapper cap still invalidates an approval. Order-independent.
export function hashSchema(properties: ScannedProperty[]): string {
  const canonical = properties
    .map((p) => ({
      id: p.id,
      name: p.name,
      notionType: p.notionType,
      optionNames: p.optionNames ? [...p.optionNames] : undefined,
      relationTargetId: p.relationTargetId,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
