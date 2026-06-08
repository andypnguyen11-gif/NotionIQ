import { z } from 'zod'

export const RoleSchema = z.enum(['date', 'measure', 'dimension', 'status', 'title', 'ignore'])
export type Role = z.infer<typeof RoleSchema>

export const FieldMappingSchema = z.object({
  notionPropertyId: z.string().min(1),
  name: z.string().min(1),
  notionType: z.string().min(1),
  optionNames: z.array(z.string()).optional(),
  relationTargetName: z.string().optional(),
  candidateRole: RoleSchema,
  role: RoleSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(200),
})
export type FieldMapping = z.infer<typeof FieldMappingSchema>

export const DatabaseMappingProposalSchema = z.object({
  classification: z.string().min(1),
  occurredAtPropertyId: z.string().nullable(),
  fields: z.array(FieldMappingSchema),
  modelVersion: z.string().min(1),
  promptVersion: z.string().min(1),
})
export type DatabaseMappingProposal = z.infer<typeof DatabaseMappingProposalSchema>
