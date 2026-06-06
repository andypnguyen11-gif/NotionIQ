import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getPrisma } from '@/lib/prisma'
import { disconnectNotion } from '@/lib/data/connections'

export async function POST() {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const disconnected = await disconnectNotion(getPrisma(), userId)
  return NextResponse.json({ disconnected })
}
