'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function DisconnectButton() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const router = useRouter()

  async function onClick() {
    setBusy(true)
    setError(false)
    try {
      const res = await fetch('/api/notion/disconnect', { method: 'POST' })
      if (res.ok) {
        router.refresh() // re-render the server page so the UI reflects the new state
      } else {
        setError(true) // don't refresh into a stale/incoherent state on failure
      }
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1">
      <button
        onClick={onClick}
        disabled={busy}
        className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
      >
        {busy ? 'Disconnecting…' : 'Disconnect Notion'}
      </button>
      {error && (
        <p className="text-sm text-red-600">Couldn’t disconnect. Please try again.</p>
      )}
    </div>
  )
}
