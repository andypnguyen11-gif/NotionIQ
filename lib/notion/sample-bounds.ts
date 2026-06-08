import type { RawRow } from './notion-client'

export const BOUNDS = {
  MAX_SAMPLE_ROWS: 20,
  MAX_PROPERTIES: 50,
  MAX_CELL_CHARS: 200,
  MAX_OPTION_NAMES: 50,
} as const

function truncateCell(v: string): string {
  return v.length > BOUNDS.MAX_CELL_CHARS ? v.slice(0, BOUNDS.MAX_CELL_CHARS) + '…' : v
}

export function boundSample(rows: RawRow[]): RawRow[] {
  return rows.slice(0, BOUNDS.MAX_SAMPLE_ROWS).map((r) => {
    const values: Record<string, string> = {}
    for (const [k, v] of Object.entries(r.values)) values[k] = truncateCell(v)
    return { values }
  })
}
