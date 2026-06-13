import { z } from 'zod'
import { NamedMetricSchema } from './metrics'

export const CHART_CONTRACT_VERSION = 1 as const

// A resolved, validated metric request stored inside chart config. classification is baked in at
// build time (chart-builder), so aggregation never needs a DB round-trip for it.
export const MetricRequestSchema = z
  .object({
    metric: NamedMetricSchema,
    measureFieldId: z.string().min(1).optional(),
    classification: z.string().min(1).optional(),
  })
  .superRefine((req, ctx) => {
    if ((req.metric === 'sum' || req.metric === 'average' || req.metric === 'revenue') && !req.measureFieldId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${req.metric} requires a measureFieldId` })
    }
    if (req.metric === 'revenue' && !req.classification) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'revenue requires a classification' })
    }
  })
export type MetricRequest = z.infer<typeof MetricRequestSchema>

const CategoricalConfig = z.object({
  shape: z.literal('categorical'),
  metric: MetricRequestSchema,
  groupByFieldId: z.string().min(1),
  groupByKind: z.enum(['dimension', 'status']),
  topN: z.number().int().min(1).max(50).default(20),
  renderer: z.enum(['bar', 'pie']).default('bar'),
})
const TimeseriesConfig = z.object({
  shape: z.literal('timeseries'),
  metric: MetricRequestSchema,
  bucket: z.enum(['day', 'week', 'month']),
  renderer: z.literal('line').default('line'),
})
const KpiConfig = z.object({
  shape: z.literal('kpi'),
  metric: MetricRequestSchema,
})

export const ChartConfigSchema = z.discriminatedUnion('shape', [CategoricalConfig, TimeseriesConfig, KpiConfig])
export type ChartConfig = z.infer<typeof ChartConfigSchema>
export type ChartShape = ChartConfig['shape']

// --- versioned wire contract (ADR-6) ---
const Base = { version: z.literal(CHART_CONTRACT_VERSION), snapshotVersion: z.number().int() }

const UnsupportedContract = z.object({
  kind: z.literal('unsupported'),
  version: z.literal(CHART_CONTRACT_VERSION),
  reason: z.string().min(1),
})
const CategoricalData = z.object({
  kind: z.literal('data'), ...Base, shape: z.literal('categorical'),
  points: z.array(z.object({ label: z.string(), value: z.number() })),
  truncated: z.boolean(),
  omittedGroupCount: z.number().int(),
})
const TimeseriesData = z.object({
  kind: z.literal('data'), ...Base, shape: z.literal('timeseries'),
  granularity: z.enum(['day', 'week', 'month']),
  points: z.array(z.object({ bucket: z.string(), value: z.number() })),
})
const KpiData = z.object({
  kind: z.literal('data'), ...Base, shape: z.literal('kpi'),
  value: z.number(),
})

export const ChartDataContractSchema = z.union([UnsupportedContract, CategoricalData, TimeseriesData, KpiData])
export type ChartDataContract = z.infer<typeof ChartDataContractSchema>
