// lib/notion/report-writer.ts
import type { AssembledReport } from '@/lib/reports/assemble'

export const SENTINEL_START = '⟦notioniq:report:start⟧'
export const SENTINEL_END = '⟦notioniq:report:end⟧'

const SECTION_HEADING: Record<string, string> = {
  summary: 'Summary',
  metric: 'Key metrics',
  trend: 'What changed',
  warning: 'Watch-outs',
  recommendation: 'Recommendations',
}

// Minimal client surface the writer needs (subset of notion-client).
export interface ReportWriterClient {
  createPage(args: { parentPageId: string; title: string }): Promise<string>
  appendBlockChildren(blockId: string, children: unknown[]): Promise<string[]>
  deleteBlock(blockId: string): Promise<void>
}

function paragraph(content: string): unknown {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content } }] } }
}
function heading(content: string): unknown {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content } }] } }
}

// Deterministic block payload from the assembled report (sentinel-wrapped). Pure.
export function buildManagedBlocks(report: AssembledReport): unknown[] {
  const blocks: unknown[] = [paragraph(SENTINEL_START)]
  for (const section of report.sections) {
    blocks.push(heading(SECTION_HEADING[section.section] ?? section.section))
    for (const item of section.items) blocks.push(paragraph(item.text))
  }
  blocks.push(paragraph(SENTINEL_END))
  return blocks
}

export interface WriteManagedInput {
  report: AssembledReport
  existing: { notionPageId: string | null; ownedBlockIds: string[] }
  parentPageId: string
  title: string
}

// Insert-before-delete (spec D-7). Throws on Notion failure WITHOUT having deleted the old
// region, so the previous report stays live. Best-effort cleanup of the old blocks happens only
// after the new region is in place.
export async function writeManagedReport(client: ReportWriterClient, input: WriteManagedInput): Promise<{ notionPageId: string; ownedBlockIds: string[] }> {
  const notionPageId = input.existing.notionPageId ?? (await client.createPage({ parentPageId: input.parentPageId, title: input.title }))
  const newBlockIds = await client.appendBlockChildren(notionPageId, buildManagedBlocks(input.report))
  // New region is live; now remove the old owned blocks (only the ones we recorded).
  for (const id of input.existing.ownedBlockIds) {
    await client.deleteBlock(id)
  }
  return { notionPageId, ownedBlockIds: newBlockIds }
}
