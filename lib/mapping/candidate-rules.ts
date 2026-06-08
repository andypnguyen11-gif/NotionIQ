import type { Role } from '@/lib/contracts/mapping'

export interface CandidateInput {
  notionType: string
  formulaResultType?: string
  rollupResultType?: string
}

// Deterministic prior: map a Notion property type to a candidate role. The AI refines
// these later; this is intentionally conservative (unknowns -> ignore).
export function candidateRole(p: CandidateInput): Role {
  switch (p.notionType) {
    case 'title':
      return 'title'
    case 'date':
    case 'created_time':
    case 'last_edited_time':
      return 'date'
    case 'number':
      return 'measure'
    case 'formula':
      return p.formulaResultType === 'number' ? 'measure' : 'ignore'
    case 'rollup':
      return p.rollupResultType === 'number' ? 'measure' : 'ignore'
    case 'select':
    case 'multi_select':
    case 'relation':
    case 'people':
      return 'dimension'
    case 'status':
      return 'status'
    default:
      return 'ignore'
  }
}
