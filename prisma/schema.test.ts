import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'

// Offline check: `Prisma.ModelName` is a generated const object listing every model,
// so this verifies `prisma generate` produced our models WITHOUT constructing a client
// (Prisma 7's driver-adapter engine requires an adapter to instantiate — see lib/prisma.ts).
describe('prisma schema', () => {
  it('generates the workspace, workspaceMember, and notionConnection models', () => {
    expect(Object.keys(Prisma.ModelName)).toEqual(
      expect.arrayContaining(['Workspace', 'WorkspaceMember', 'NotionConnection']),
    )
  })
})
