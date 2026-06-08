import type { PrismaClient } from '@prisma/client'

export type SaveConnectionInput = {
  userId: string
  notionWorkspaceId: string
  notionWorkspaceName: string | null
  botId: string
  encryptedToken: string
}

/**
 * Resolves (or creates) the user's workspace via WorkspaceMember, then upserts its
 * Notion connection. Tenant-scoped by workspaceId (ADR-3). Reconnecting replaces the
 * stored token. Returns the workspace id.
 */
export async function saveNotionConnection(
  prisma: PrismaClient,
  input: SaveConnectionInput,
): Promise<{ workspaceId: string }> {
  const membership = await prisma.workspaceMember.findUnique({ where: { userId: input.userId } })

  let workspaceId: string
  if (membership) {
    workspaceId = membership.workspaceId
  } else {
    const workspace = await prisma.workspace.create({
      data: {
        name: input.notionWorkspaceName ?? 'My Workspace',
        members: { create: { userId: input.userId, role: 'owner' } },
      },
    })
    workspaceId = workspace.id
  }

  const connectionFields = {
    notionWorkspaceId: input.notionWorkspaceId,
    notionWorkspaceName: input.notionWorkspaceName,
    botId: input.botId,
    encryptedToken: input.encryptedToken,
  }

  await prisma.notionConnection.upsert({
    where: { workspaceId },
    create: { workspaceId, ...connectionFields },
    update: connectionFields,
  })

  return { workspaceId }
}

export async function getWorkspaceForUser(prisma: PrismaClient, userId: string) {
  return prisma.workspace.findFirst({
    where: { members: { some: { userId } } },
    include: { notionConnection: true },
  })
}

export async function getConnectionForUser(prisma: PrismaClient, userId: string) {
  const workspace = await prisma.workspace.findFirst({
    where: { members: { some: { userId } } },
    include: { notionConnection: true },
  })
  return workspace?.notionConnection ?? null
}

export async function disconnectNotion(prisma: PrismaClient, userId: string): Promise<boolean> {
  const workspace = await prisma.workspace.findFirst({
    where: { members: { some: { userId } } },
    include: { notionConnection: true },
  })
  if (!workspace?.notionConnection) return false
  await prisma.notionConnection.delete({ where: { workspaceId: workspace.id } })
  return true
}
