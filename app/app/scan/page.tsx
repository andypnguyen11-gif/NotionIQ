import { auth } from '@clerk/nextjs/server'
import { getPrisma } from '@/lib/prisma'
import { getConnectionForUser } from '@/lib/data/connections'
import { ScanClient } from './scan-client'

export default async function ScanPage() {
  const { userId } = await auth()
  const connection = userId ? await getConnectionForUser(getPrisma(), userId) : null
  if (!connection) {
    return (
      <main className="space-y-4 p-8">
        <h1 className="text-xl font-semibold">Understand your workspace</h1>
        <p className="text-sm text-gray-600">Connect Notion first to scan your databases.</p>
        <a href="/api/notion/connect" className="inline-block rounded bg-black px-4 py-2 text-sm text-white">Connect Notion</a>
      </main>
    )
  }
  return (
    <main className="space-y-4 p-8">
      <h1 className="text-xl font-semibold">Understand your workspace</h1>
      <ScanClient />
    </main>
  )
}
