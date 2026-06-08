import { DatabaseMappingProposalSchema, type DatabaseMappingProposal, type Role } from '@/lib/contracts/mapping'

export interface MappingEdits {
  occurredAtPropertyId: string | null
  roles: Record<string, Role> // notionPropertyId -> chosen role
}

// Apply the reviewer's role/occurredAt overrides onto a proposal and re-validate.
export function applyEdits(proposal: DatabaseMappingProposal, edits: MappingEdits): DatabaseMappingProposal {
  const ids = new Set(proposal.fields.map((f) => f.notionPropertyId))
  for (const id of Object.keys(edits.roles)) {
    if (!ids.has(id)) throw new Error(`unknown property in edits: ${id}`)
  }
  const fields = proposal.fields.map((f) =>
    edits.roles[f.notionPropertyId] ? { ...f, role: edits.roles[f.notionPropertyId] } : f,
  )
  if (edits.occurredAtPropertyId !== null) {
    const target = fields.find((f) => f.notionPropertyId === edits.occurredAtPropertyId)
    if (!target || target.role !== 'date') throw new Error('occurredAt must reference a date-role field')
  }
  return DatabaseMappingProposalSchema.parse({ ...proposal, fields, occurredAtPropertyId: edits.occurredAtPropertyId })
}
