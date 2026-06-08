import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { getEnv } from '@/lib/env'
import { getPrisma } from '@/lib/prisma'
import { exchangeCodeForToken } from '@/lib/notion/oauth'
import { verifyState, OAUTH_NONCE_COOKIE } from '@/lib/notion/oauth-state'
import { encryptToken } from '@/lib/crypto/token-cipher'
import { saveNotionConnection } from '@/lib/data/connections'
import { log } from '@/lib/log'

// Clear the single-use nonce, mirroring the attributes connect set it with so the
// browser reliably drops it. `secure` is scoped to https for local-dev parity.
function clearNonce(res: NextResponse, appUrl: string): NextResponse {
  res.cookies.set(OAUTH_NONCE_COOKIE, '', {
    httpOnly: true,
    secure: appUrl.startsWith('https://'),
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  return res
}

function redirectToApp(appUrl: string, status: string): NextResponse {
  return clearNonce(NextResponse.redirect(new URL(`/app?notion=${status}`, appUrl)), appUrl)
}

export async function GET(req: NextRequest) {
  const env = getEnv()
  const appUrl = env.NEXT_PUBLIC_APP_URL
  const params = req.nextUrl.searchParams

  if (params.get('error')) {
    return redirectToApp(appUrl, 'denied')
  }

  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) {
    return redirectToApp(appUrl, 'invalid')
  }

  const { userId } = await auth()
  if (!userId) {
    return clearNonce(NextResponse.redirect(new URL('/sign-in', appUrl)), appUrl)
  }

  const payload = verifyState(state, env.OAUTH_STATE_SECRET, Date.now())
  const cookieNonce = req.cookies.get(OAUTH_NONCE_COOKIE)?.value
  if (!payload || payload.u !== userId || !cookieNonce || cookieNonce !== payload.n) {
    log.warn('notion_oauth_state_invalid', { userId })
    return redirectToApp(appUrl, 'invalid')
  }

  try {
    const token = await exchangeCodeForToken({
      code,
      clientId: env.NOTION_OAUTH_CLIENT_ID,
      clientSecret: env.NOTION_OAUTH_CLIENT_SECRET,
      redirectUri: env.NOTION_OAUTH_REDIRECT_URI,
    })

    // AAD binds the ciphertext to this Notion workspace (known before any DB write).
    const encryptedToken = encryptToken(token.accessToken, env.TOKEN_ENCRYPTION_KEY, token.workspaceId)

    await saveNotionConnection(getPrisma(), {
      userId,
      notionWorkspaceId: token.workspaceId,
      notionWorkspaceName: token.workspaceName,
      botId: token.botId,
      encryptedToken,
    })

    log.info('notion_connected', { userId, notionWorkspaceId: token.workspaceId })
    return redirectToApp(appUrl, 'connected')
  } catch {
    log.error('notion_oauth_exchange_failed', { userId })
    return redirectToApp(appUrl, 'error')
  }
}
