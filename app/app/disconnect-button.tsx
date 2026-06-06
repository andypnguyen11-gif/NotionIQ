'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function DisconnectButton() {
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function onClick() {
    setBusy(true)
    try {
      await fetch('/api/notion/disconnect', { method: 'POST' })
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="rounded border px-3 py-1.5 text-sm disabled:opacity-50"
    >
      {busy ? 'Disconnecting…' : 'Disconnect Notion'}
    </button>
  )
}
