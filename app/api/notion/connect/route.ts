import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { buildAuthorizeUrl } from '@/lib/notion/oauth'
import { signState, OAUTH_NONCE_COOKIE } from '@/lib/notion/oauth-state'

const STATE_TTL_MS = 10 * 60 * 1000

export async function GET() {
  const env = getEnv()
  const { userId } = await auth()

  if (!userId) {
    return NextResponse.redirect(new URL('/sign-in', env.NEXT_PUBLIC_APP_URL))
  }

  const nonce = randomBytes(16).toString('hex')
  const state = signState(
    { u: userId, n: nonce, e: Date.now() + STATE_TTL_MS },
    env.OAUTH_STATE_SECRET,
  )

  const authorizeUrl = buildAuthorizeUrl({
    clientId: env.NOTION_OAUTH_CLIENT_ID,
    redirectUri: env.NOTION_OAUTH_REDIRECT_URI,
    state,
  })

  const res = NextResponse.redirect(authorizeUrl)
  res.cookies.set(OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax', // sent on the top-level GET redirect back from Notion
    path: '/',
    maxAge: STATE_TTL_MS / 1000,
  })
  return res
}
