import { auth } from '@clerk/nextjs/server'
import { getPrisma } from '@/lib/prisma'
import { getWorkspaceForUser } from '@/lib/data/connections'
import { DisconnectButton } from './disconnect-button'

export default async function AppHome() {
  const { userId } = await auth()
  const workspace = userId ? await getWorkspaceForUser(getPrisma(), userId) : null
  const connection = workspace?.notionConnection ?? null

  return (
    <main className="space-y-4 p-8">
      <h1 className="text-xl font-semibold">NotionIQ</h1>
      {connection ? (
        <div className="space-y-2">
          <p className="text-sm text-gray-600">
            Connected to{' '}
            <strong>{connection.notionWorkspaceName ?? 'your Notion workspace'}</strong>.
          </p>
          <DisconnectButton />
        </div>
      ) : (
        <a
          href="/api/notion/connect"
          className="inline-block rounded bg-black px-4 py-2 text-sm text-white"
        >
          Connect Notion
        </a>
      )}
    </main>
  )
}
