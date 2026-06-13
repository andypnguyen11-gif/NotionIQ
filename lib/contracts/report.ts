// lib/contracts/report.ts
import { z } from 'zod'

// Computed via M3 primitives (count/sum/avg/min/max) — fact and verifier share this path.
export const MetricKindSchema = z.enum(['count', 'sum', 'average', 'min', 'max'])
export type MetricKind = z.infer<typeof MetricKindSchema>

export const MetricRequestSpecSchema = z.object({
  metric: MetricKindSchema,
  sourceDatabaseId: z.string().min(1),
  measureFieldId: z.string().min(1).optional(), // notionPropertyId of the measure
  groupByDimensionId: z.string().min(1).optional(),
  timeGranularity: z.enum(['day', 'week', 'month']).optional(), // reserved; not enumerated in M4
})
export type MetricRequestSpec = z.infer<typeof MetricRequestSpecSchema>

export const FactSchema = z.object({
  factId: z.string().min(1),
  metricRequest: MetricRequestSpecSchema,
  label: z.string().min(1),
  value: z.number().nullable(),
  groups: z.array(z.object({ key: z.string(), value: z.number() })).optional(),
  previousValue: z.number().optional(),
  delta: z.object({ absolute: z.number(), relative: z.number() }).optional(),
  snapshotVersion: z.number().int().nonnegative(),
  computedAt: z.string().min(1),
})
export type Fact = z.infer<typeof FactSchema>

export const FactSheetSchema = z.object({
  snapshotVersion: z.number().int().nonnegative(),
  generatedAt: z.string().min(1),
  facts: z.array(FactSchema),
})
export type FactSheet = z.infer<typeof FactSheetSchema>

export const ClaimAssertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('value'), factId: z.string().min(1), expected: z.number() }),
  z.object({
    kind: z.literal('trend'),
    factId: z.string().min(1),
    expectedDelta: z.object({ absolute: z.number().optional(), relative: z.number().optional() }).optional(),
    direction: z.enum(['up', 'down', 'flat']).optional(),
  }),
  z.object({ kind: z.literal('rank'), factId: z.string().min(1), groupKey: z.string().min(1), position: z.enum(['max', 'min']) }),
  z.object({ kind: z.literal('citation'), factIds: z.array(z.string().min(1)).min(1) }),
])
export type ClaimAssertion = z.infer<typeof ClaimAssertionSchema>

export const SectionSchema = z.enum(['summary', 'metric', 'trend', 'warning', 'recommendation'])
export type Section = z.infer<typeof SectionSchema>

export const SeveritySchema = z.enum(['low', 'med', 'high'])
export type Severity = z.infer<typeof SeveritySchema>

export const InsightClaimSchema = z.object({
  section: SectionSchema,
  template: z.string().min(1),
  assertion: ClaimAssertionSchema,
  severity: SeveritySchema.optional(),
})
export type InsightClaim = z.infer<typeof InsightClaimSchema>

export const InsightClaimsSchema = z.object({ claims: z.array(InsightClaimSchema) })
export type InsightClaims = z.infer<typeof InsightClaimsSchema>

export const VerificationStatusSchema = z.enum(['verified', 'mismatched', 'unsupported', 'unevidenced', 'dropped'])
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>

// The verifier's output (not persisted verbatim; flattened into ReportClaim rows).
export interface VerifiedClaim extends InsightClaim {
  verificationStatus: VerificationStatus
  reason?: string
  fact?: Fact // recomputed fact used for rendering + frozen audit
  renderedText?: string
}

export const ReportRunStatusSchema = z.enum(['queued', 'running', 'rewriting', 'committed', 'write_failed', 'failed'])
export type ReportRunStatus = z.infer<typeof ReportRunStatusSchema>

export const ReportRunResultsSchema = z.object({
  factsConsidered: z.number().int().nonnegative(),
  claimsProposed: z.number().int().nonnegative(),
  claimsVerified: z.number().int().nonnegative(),
  claimsDropped: z.array(z.object({ kind: z.string(), reason: z.string() })),
  empty: z.boolean(),
})
export type ReportRunResults = z.infer<typeof ReportRunResultsSchema>
