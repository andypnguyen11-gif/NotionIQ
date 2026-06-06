import { describe, it, expect, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { saveNotionConnection, getWorkspaceForUser, disconnectNotion } from './connections'

function fakePrisma(overrides: Record<string, unknown> = {}) {
  return {
    workspaceMember: { findUnique: vi.fn(async () => null) },
    workspace: {
      create: vi.fn(async () => ({ id: 'ws_new' })),
      findFirst: vi.fn(async () => null),
    },
    notionConnection: {
      upsert: vi.fn(async () => ({ id: 'conn_1' })),
      delete: vi.fn(async () => ({ id: 'conn_1' })),
    },
    ...overrides,
  } as unknown as PrismaClient
}

const input = {
  userId: 'user_123',
  notionWorkspaceId: 'ws_notion',
  notionWorkspaceName: 'Acme',
  botId: 'bot',
  encryptedToken: 'cipher',
}

describe('saveNotionConnection', () => {
  it('creates a workspace + owner membership for a new user, then upserts the connection', async () => {
    const prisma = fakePrisma()
    const result = await saveNotionConnection(prisma, input)
    expect(result).toEqual({ workspaceId: 'ws_new' })
    expect(prisma.workspace.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          members: { create: { userId: 'user_123', role: 'owner' } },
        }),
      }),
    )
    expect(prisma.notionConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws_new' } }),
    )
  })

  it('reuses the existing workspace for a returning user', async () => {
    const prisma = fakePrisma({
      workspaceMember: { findUnique: vi.fn(async () => ({ workspaceId: 'ws_existing', userId: 'user_123' })) },
      workspace: { create: vi.fn(), findFirst: vi.fn() },
    })
    const result = await saveNotionConnection(prisma, input)
    expect(result).toEqual({ workspaceId: 'ws_existing' })
    expect(prisma.workspace.create).not.toHaveBeenCalled()
    expect(prisma.notionConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws_existing' } }),
    )
  })
})

describe('getWorkspaceForUser', () => {
  it('reads the workspace via membership with its connection', async () => {
    const prisma = fakePrisma({
      workspace: {
        findFirst: vi.fn(async () => ({ id: 'ws_1', notionConnection: { id: 'conn_1' } })),
        create: vi.fn(),
      },
    })
    const ws = await getWorkspaceForUser(prisma, 'user_123')
    expect(ws).toMatchObject({ id: 'ws_1' })
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { members: { some: { userId: 'user_123' } } },
      include: { notionConnection: true },
    })
  })
})

describe('disconnectNotion', () => {
  it('returns false when there is no connection', async () => {
    const prisma = fakePrisma({
      workspace: { findFirst: vi.fn(async () => ({ id: 'ws_1', notionConnection: null })), create: vi.fn() },
    })
    expect(await disconnectNotion(prisma, 'user_123')).toBe(false)
  })

  it('deletes the connection and returns true when present', async () => {
    const del = vi.fn(async () => ({ id: 'conn_1' }))
    const prisma = fakePrisma({
      workspace: {
        findFirst: vi.fn(async () => ({ id: 'ws_1', notionConnection: { id: 'conn_1' } })),
        create: vi.fn(),
      },
      notionConnection: { upsert: vi.fn(), delete: del },
    })
    expect(await disconnectNotion(prisma, 'user_123')).toBe(true)
    expect(del).toHaveBeenCalledWith({ where: { workspaceId: 'ws_1' } })
  })
})
