import { z } from 'zod'

export const SnapshotRunStatusSchema = z.enum(['queued', 'running', 'committed', 'partial', 'failed'])
export type SnapshotRunStatus = z.infer<typeof SnapshotRunStatusSchema>

// Shared by the job (writes), the API (reads), and the UI (renders) — one contract, no loose Json.
export const SnapshotDbResultSchema = z.object({
  sourceDatabaseId: z.string().min(1),
  status: z.enum(['ingested', 'failed']),
  rowCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
})
export type SnapshotDbResult = z.infer<typeof SnapshotDbResultSchema>

export const SnapshotRunResultsSchema = z.array(SnapshotDbResultSchema)
export type SnapshotRunResults = z.infer<typeof SnapshotRunResultsSchema>
