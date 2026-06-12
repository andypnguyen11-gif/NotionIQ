import type { MetricRecord } from '@/lib/contracts/normalized'
import type { MetricResult, NamedMetricRequest } from '@/lib/contracts/metrics'
import { count, sum, avg } from './primitives'

// Conservative (spec D-7): resolve only when evidence is unambiguous; otherwise refuse with a
// reason. Never guesses business meaning.
export function resolveNamedMetric(records: MetricRecord[], req: NamedMetricRequest): MetricResult {
  const ids = req.measureFieldIds ?? []
  const loneMeasure = ids.length === 1 ? ids[0] : null

  switch (req.metric) {
    case 'count':
      return { kind: 'value', value: count(records) }
    case 'sum':
      return loneMeasure
        ? { kind: 'value', value: sum(records, loneMeasure) }
        : { kind: 'unsupported', reason: 'sum requires exactly one measure field' }
    case 'average':
      if (!loneMeasure) return { kind: 'unsupported', reason: 'average requires exactly one measure field' }
      if (records.length === 0) return { kind: 'unsupported', reason: 'average of an empty record set' }
      return { kind: 'value', value: avg(records, loneMeasure) }
    case 'revenue':
      if (!loneMeasure || !req.classification) {
        return { kind: 'unsupported', reason: 'revenue requires a lone measure and a database classification' }
      }
      return { kind: 'value', value: sum(records, loneMeasure) }
    default:
      return { kind: 'unsupported', reason: 'unknown metric' }
  }
}
