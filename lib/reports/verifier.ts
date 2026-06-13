// lib/reports/verifier.ts
import type { Fact, FactSheet, InsightClaim, MetricRequestSpec, VerifiedClaim } from '@/lib/contracts/report'

export type Recompute = (req: MetricRequestSpec) => Fact

export const ALLOWED_PLACEHOLDERS = ['value', 'previousValue', 'delta.absolute', 'delta.relative', 'groupKey'] as const

const REL_EPSILON = 1e-6
function approxEqual(a: number, b: number): boolean {
  if (Number.isInteger(a) && Number.isInteger(b)) return a === b
  const scale = Math.max(1, Math.abs(a), Math.abs(b))
  return Math.abs(a - b) <= REL_EPSILON * scale
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
}

function fail(claim: InsightClaim, status: VerifiedClaim['verificationStatus'], reason: string): VerifiedClaim {
  return { ...claim, verificationStatus: status, reason }
}

// A placeholder is resolvable only if the fact can supply it.
function placeholderResolvable(p: string, fact: Fact, isRank: boolean): boolean {
  switch (p) {
    case 'value': return fact.value !== null || isRank // rank resolves {value} from the group
    case 'previousValue': return fact.previousValue !== undefined
    case 'delta.absolute':
    case 'delta.relative': return fact.delta !== undefined
    case 'groupKey': return isRank
    default: return false
  }
}

export function verifyClaims(claims: InsightClaim[], sheet: FactSheet, recompute: Recompute): VerifiedClaim[] {
  const byId = new Map(sheet.facts.map((f) => [f.factId, f]))
  return claims.map((claim) => verifyOne(claim, byId, recompute))
}

function verifyOne(claim: InsightClaim, byId: Map<string, Fact>, recompute: Recompute): VerifiedClaim {
  const a = claim.assertion
  const used = placeholders(claim.template)
  const unknown = used.filter((p) => !ALLOWED_PLACEHOLDERS.includes(p as never))
  if (unknown.length > 0) return fail(claim, 'mismatched', `unknown placeholder(s): ${unknown.join(', ')}`)

  const prose = claim.template.replace(/\{[^}]+\}/g, '')
  if (/\d/.test(prose)) return fail(claim, 'mismatched', 'literal digit in template text')

  if (a.kind === 'citation') {
    if (used.length > 0) return fail(claim, 'mismatched', 'citation template must contain no placeholders')
    const verifiable = a.factIds.some((id) => {
      const f = byId.get(id)
      if (!f) return false
      const r = recompute(f.metricRequest)
      return r.value !== null || (r.groups?.length ?? 0) > 0
    })
    return verifiable ? { ...claim, verificationStatus: 'verified' } : fail(claim, 'unevidenced', 'no cited fact is verifiable')
  }

  const declared = byId.get(a.factId)
  if (!declared) return fail(claim, 'unsupported', `unknown factId ${a.factId}`)
  const fact = recompute(declared.metricRequest) // genuine recompute from the request
  const isRank = a.kind === 'rank'

  const badPlaceholder = used.find((p) => !placeholderResolvable(p, fact, isRank))
  if (badPlaceholder) return fail(claim, 'unsupported', `placeholder {${badPlaceholder}} not resolvable from fact`)

  if (a.kind === 'value') {
    if (fact.value === null) return fail(claim, 'unsupported', 'fact value is null')
    if (!approxEqual(fact.value, a.expected)) return fail(claim, 'mismatched', `expected ${a.expected}, engine ${fact.value}`)
    return { ...claim, verificationStatus: 'verified', fact }
  }

  if (a.kind === 'trend') {
    if (!fact.delta || fact.previousValue === undefined) return fail(claim, 'unsupported', 'no previous-snapshot delta')
    const dir = fact.delta.absolute > 0 ? 'up' : fact.delta.absolute < 0 ? 'down' : 'flat'
    if (a.direction && a.direction !== dir) return fail(claim, 'mismatched', `asserted ${a.direction}, engine ${dir}`)
    if (a.expectedDelta?.absolute !== undefined && !approxEqual(a.expectedDelta.absolute, fact.delta.absolute)) return fail(claim, 'mismatched', 'absolute delta mismatch')
    if (a.expectedDelta?.relative !== undefined && !approxEqual(a.expectedDelta.relative, fact.delta.relative)) return fail(claim, 'mismatched', 'relative delta mismatch')
    return { ...claim, verificationStatus: 'verified', fact }
  }

  // rank
  const groups = fact.groups ?? []
  if (groups.length === 0) return fail(claim, 'unsupported', 'fact has no groups')
  const target = a.position === 'max' ? groups.reduce((x, y) => (y.value > x.value ? y : x)) : groups.reduce((x, y) => (y.value < x.value ? y : x))
  if (target.key !== a.groupKey) return fail(claim, 'mismatched', `${a.position} is ${target.key}, not ${a.groupKey}`)
  return { ...claim, verificationStatus: 'verified', fact }
}
