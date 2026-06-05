import { z } from 'zod'

const AUTHORIZE_URL = 'https://api.notion.com/v1/oauth/authorize'
const TOKEN_URL = 'https://api.notion.com/v1/oauth/token'
const NOTION_VERSION = '2022-06-28'

export function buildAuthorizeUrl(params: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('owner', 'user')
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('state', params.state)
  return url.toString()
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  bot_id: z.string().min(1),
  workspace_id: z.string().min(1),
  workspace_name: z.string().nullable().optional(),
})

export type NotionTokenResult = {
  accessToken: string
  botId: string
  workspaceId: string
  workspaceName: string | null
}

export async function exchangeCodeForToken(params: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
  fetchImpl?: typeof fetch
}): Promise<NotionTokenResult> {
  const doFetch = params.fetchImpl ?? fetch
  const basic = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString('base64')

  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_VERSION,
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  })

  if (!res.ok) {
    throw new Error(`Notion token exchange failed: ${res.status}`)
  }

  const parsed = TokenResponse.parse(await res.json())
  return {
    accessToken: parsed.access_token,
    botId: parsed.bot_id,
    workspaceId: parsed.workspace_id,
    workspaceName: parsed.workspace_name ?? null,
  }
}
