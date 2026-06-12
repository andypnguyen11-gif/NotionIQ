'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fieldRowsForReview, scanProgressLabel, isReviewable } from './scan-view'
import { snapshotCtaLabel, snapshotProgressLabel, canBuildSnapshot } from './snapshot-view'
import type { DatabaseMappingProposal, Role } from '@/lib/contracts/mapping'
import type { SnapshotRunResults } from '@/lib/contracts/snapshot-run'

interface DbItem { id: string; title: string }
interface MappingRow {
  id: string
  notionDatabaseId: string
  databaseName: string
  status: string
  proposedMapping: DatabaseMappingProposal
}
type DbResult = { notionDatabaseId: string; status: 'scanned' | 'mapped' | 'failed' }
const ROLES: Role[] = ['date', 'measure', 'dimension', 'status', 'title', 'ignore']
const TERMINAL_SNAPSHOT_STATUSES = ['committed', 'partial', 'failed']

export function ScanClient({ initialHasSnapshot = false }: { initialHasSnapshot?: boolean }) {
  const [dbs, setDbs] = useState<DbItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [scanRunId, setScanRunId] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('idle')
  const [results, setResults] = useState<DbResult[]>([])
  const [mappings, setMappings] = useState<MappingRow[]>([])
  // per-mapping local edits: { [mappingId]: { occurredAtPropertyId, roles } }
  const [edits, setEdits] = useState<Record<string, { occurredAtPropertyId: string | null; roles: Record<string, Role> }>>({})
  const [approved, setApproved] = useState<Set<string>>(new Set())
  const [snapshotRunId, setSnapshotRunId] = useState<string | null>(null)
  const [snapshotStatus, setSnapshotStatus] = useState<string>('idle')
  const [snapshotResults, setSnapshotResults] = useState<SnapshotRunResults>([])
  const [hasSnapshot, setHasSnapshot] = useState(initialHasSnapshot)
  const buildingRef = useRef(false)

  useEffect(() => {
    fetch('/api/notion/databases').then((r) => r.json()).then((d) => setDbs(d.databases ?? []))
  }, [])

  useEffect(() => {
    if (!scanRunId || isReviewable(status) || status === 'failed') return
    const t = setInterval(async () => {
      const r = await fetch(`/api/scan/${scanRunId}`).then((x) => x.json())
      setStatus(r.status)
      setResults(r.results ?? [])
    }, 1500)
    return () => clearInterval(t)
  }, [scanRunId, status])

  useEffect(() => {
    if (!snapshotRunId || TERMINAL_SNAPSHOT_STATUSES.includes(snapshotStatus)) return
    const t = setInterval(async () => {
      const r = await fetch(`/api/snapshot/${snapshotRunId}`).then((x) => x.json())
      setSnapshotStatus(r.status)
      setSnapshotResults(r.results ?? [])
      if (r.status === 'committed') setHasSnapshot(true)
      if (TERMINAL_SNAPSHOT_STATUSES.includes(r.status)) buildingRef.current = false
    }, 1500)
    return () => clearInterval(t)
  }, [snapshotRunId, snapshotStatus])

  // When the run is reviewable, load the proposals and seed edit state from the AI roles.
  const loadMappings = useCallback(async (runId: string) => {
    const { mappings: rows } = await fetch(`/api/mappings?scanRunId=${runId}`).then((x) => x.json())
    setMappings(rows)
    const seeded: typeof edits = {}
    for (const m of rows as MappingRow[]) {
      seeded[m.id] = {
        occurredAtPropertyId: m.proposedMapping.occurredAtPropertyId,
        roles: Object.fromEntries(m.proposedMapping.fields.map((f) => [f.notionPropertyId, f.role])),
      }
    }
    setEdits(seeded)
  }, [])

  useEffect(() => {
    if (scanRunId && isReviewable(status)) void loadMappings(scanRunId)
  }, [scanRunId, status, loadMappings])

  async function startScan() {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ databaseIds: [...selected] }),
    })
    const data = await res.json()
    setScanRunId(data.scanRunId)
    setStatus('queued')
  }

  async function approve(mappingId: string) {
    const res = await fetch(`/api/mappings/${mappingId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(edits[mappingId]),
    })
    if (res.ok) setApproved((prev) => new Set(prev).add(mappingId))
  }

  async function buildSnapshot() {
    if (buildingRef.current) return
    buildingRef.current = true
    const res = await fetch('/api/snapshot', { method: 'POST', headers: { 'content-type': 'application/json' } })
    if (!res.ok) {
      buildingRef.current = false
      return
    }
    const data = await res.json()
    setSnapshotRunId(data.snapshotRunId)
    setSnapshotStatus('queued')
    setSnapshotResults([])
  }

  function setRole(mappingId: string, propId: string, role: Role) {
    setEdits((prev) => {
      const cur = prev[mappingId] ?? { occurredAtPropertyId: null, roles: {} }
      const roles = { ...cur.roles, [propId]: role }
      // If the field that WAS the timeline is no longer a date, clear the timeline.
      const occurredAtPropertyId = cur.occurredAtPropertyId === propId && role !== 'date' ? null : cur.occurredAtPropertyId
      return { ...prev, [mappingId]: { occurredAtPropertyId, roles } }
    })
  }

  function setOccurredAt(mappingId: string, propId: string | null) {
    setEdits((prev) => {
      const cur = prev[mappingId] ?? { occurredAtPropertyId: null, roles: {} }
      return { ...prev, [mappingId]: { ...cur, occurredAtPropertyId: propId } }
    })
  }

  return (
    <div className="space-y-6">
      {!isReviewable(status) && (
        <>
          <ul className="space-y-1">
            {dbs.map((db) => (
              <li key={db.id}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(db.id)}
                    onChange={(e) => {
                      const next = new Set(selected)
                      if (e.target.checked) next.add(db.id)
                      else next.delete(db.id)
                      setSelected(next)
                    }}
                  />
                  {db.title}
                </label>
              </li>
            ))}
          </ul>
          <button
            disabled={selected.size === 0 || (scanRunId !== null && status !== 'failed')}
            onClick={startScan}
            className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Scan selected
          </button>
        </>
      )}

      {scanRunId && <p role="status" className="text-sm text-gray-600">{scanProgressLabel({ status, results })}</p>}

      {isReviewable(status) && mappings.map((m) => {
          const rows = fieldRowsForReview({ ...m.proposedMapping, occurredAtPropertyId: edits[m.id]?.occurredAtPropertyId ?? null })
          return (
            <section key={m.id} className="space-y-2 rounded border p-4">
              <h2 className="font-medium">{m.databaseName} <span className="text-xs text-gray-500">({m.proposedMapping.classification})</span></h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th>Property</th><th>Notion type</th><th>Context</th><th>Role</th><th>Timeline</th><th>AI</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const role = edits[m.id]?.roles[row.id] ?? row.role
                    const isDate = role === 'date'
                    return (
                      <tr key={row.id} className={row.flagged ? 'bg-amber-50' : ''}>
                        <td>{row.name}</td>
                        <td>{row.notionType}</td>
                        <td className="text-xs text-gray-500">{row.optionNames?.join(', ') ?? row.relationTargetName ?? ''}</td>
                        <td>
                          <select value={role} onChange={(e) => setRole(m.id, row.id, e.target.value as Role)}>
                            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </td>
                        <td>
                          {/* Only date-role fields are eligible as the single timeline (occurredAt). */}
                          <input
                            type="radio"
                            name={`occurredAt-${m.id}`}
                            disabled={!isDate}
                            checked={edits[m.id]?.occurredAtPropertyId === row.id}
                            onChange={() => setOccurredAt(m.id, row.id)}
                            aria-label={`Use ${row.name} as the timeline`}
                          />
                        </td>
                        <td className="text-xs text-gray-400" title={row.rationale}>{Math.round(row.confidence * 100)}%</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input
                  type="radio"
                  name={`occurredAt-${m.id}`}
                  checked={!edits[m.id]?.occurredAtPropertyId}
                  onChange={() => setOccurredAt(m.id, null)}
                />
                No timeline field
              </label>
              <button
                onClick={() => approve(m.id)}
                disabled={approved.has(m.id)}
                className="rounded bg-black px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {approved.has(m.id) ? 'Approved' : 'Approve mapping'}
              </button>
            </section>
          )
        })}
      {isReviewable(status) && mappings.length > 0 && (
        <div className="space-y-2 border-t pt-4">
          <button
            onClick={buildSnapshot}
            disabled={!canBuildSnapshot({ allApproved: mappings.every((m) => approved.has(m.id) || m.status === 'approved'), building: snapshotRunId !== null && !TERMINAL_SNAPSHOT_STATUSES.includes(snapshotStatus) })}
            className="rounded bg-emerald-700 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            {snapshotCtaLabel(hasSnapshot)}
          </button>
          {snapshotRunId && <p role="status" className="text-sm text-gray-600">{snapshotProgressLabel({ status: snapshotStatus, results: snapshotResults })}</p>}
        </div>
      )}
    </div>
  )
}
