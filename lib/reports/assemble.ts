// lib/reports/assemble.ts
import type { Section, Severity, VerifiedClaim } from '@/lib/contracts/report'

export const SECTION_ORDER: Section[] = ['summary', 'metric', 'trend', 'warning', 'recommendation']
export const FALLBACK_TEXT = 'Not enough verified data to report this run.'
const SEVERITY_RANK: Record<Severity, number> = { high: 0, med: 1, low: 2 }

export interface AssembledSection {
  section: Section
  items: { text: string; severity?: Severity }[]
}
export interface AssembledReport {
  sections: AssembledSection[]
  empty: boolean
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}
function fmtPercent(n: number): string {
  const pct = Math.round(n * 1000) / 10
  return `${pct >= 0 ? '+' : ''}${pct}%`
}

// Interpolate ONLY engine-derived values. For a rank claim, {value}/{groupKey} come from the
// winning group. Never uses the AI's asserted number.
export function renderClaim(claim: VerifiedClaim): string {
  const fact = claim.fact
  const a = claim.assertion
  let groupValue: number | undefined
  let groupKey: string | undefined
  if (a.kind === 'rank' && fact?.groups) {
    const g = a.position === 'max' ? fact.groups.reduce((x, y) => (y.value > x.value ? y : x)) : fact.groups.reduce((x, y) => (y.value < x.value ? y : x))
    groupValue = g.value
    groupKey = g.key
  }
  return claim.template.replace(/\{([^}]+)\}/g, (_m, p: string) => {
    switch (p) {
      case 'value': return fmt(groupValue ?? fact?.value ?? 0)
      case 'previousValue': return fmt(fact?.previousValue ?? 0)
      case 'delta.absolute': return fmt(fact?.delta?.absolute ?? 0)
      case 'delta.relative': return fmtPercent(fact?.delta?.relative ?? 0)
      case 'groupKey': return groupKey ?? ''
      default: return ''
    }
  })
}

export function assembleReport(claims: VerifiedClaim[]): AssembledReport {
  const verified = claims.filter((c) => c.verificationStatus === 'verified')
  if (verified.length === 0) {
    return { sections: [{ section: 'summary', items: [{ text: FALLBACK_TEXT }] }], empty: true }
  }
  const sections: AssembledSection[] = []
  for (const section of SECTION_ORDER) {
    const inSection = verified
      .filter((c) => c.section === section)
      .sort((a, b) => SEVERITY_RANK[a.severity ?? 'med'] - SEVERITY_RANK[b.severity ?? 'med'])
    if (inSection.length === 0) continue
    sections.push({ section, items: inSection.map((c) => ({ text: c.renderedText ?? renderClaim(c), severity: c.severity })) })
  }
  return { sections, empty: false }
}
