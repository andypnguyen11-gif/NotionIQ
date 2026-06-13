import { z } from 'zod'

// The engine returns a number OR an explicit refusal — it never guesses (spec D-7).
export const MetricResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), value: z.number() }),
  z.object({ kind: z.literal('unsupported'), reason: z.string().min(1) }),
])
export type MetricResult = z.infer<typeof MetricResultSchema>

export const NamedMetricSchema = z.enum(['count', 'sum', 'average', 'revenue'])
export type NamedMetric = z.infer<typeof NamedMetricSchema>

export interface NamedMetricRequest {
  metric: NamedMetric
  measureFieldIds?: string[]
  classification?: string
}
