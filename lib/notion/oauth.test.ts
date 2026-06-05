import { describe, it, expect, vi } from 'vitest'
import { buildAuthorizeUrl, exchangeCodeForToken } from './oauth'

describe('buildAuthorizeUrl', () => {
  it('builds a Notion authorize URL with the required params', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'cid',
        redirectUri: 'https://app.test/api/notion/callback',
        state: 'signed-state',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://api.notion.com/v1/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('owner')).toBe('user')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/api/notion/callback')
    expect(url.searchParams.get('state')).toBe('signed-state')
  })
})

describe('exchangeCodeForToken', () => {
  const base = {
    code: 'abc',
    clientId: 'cid',
    clientSecret: 'csecret',
    redirectUri: 'https://app.test/api/notion/callback',
  }

  it('exchanges a code and maps the response (contract test)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          access_token: 'tok',
          bot_id: 'bot',
          workspace_id: 'ws',
          workspace_name: 'Acme',
        }),
        { status: 200 },
      ),
    )
    const result = await exchangeCodeForToken({ ...base, fetchImpl })
    expect(result).toEqual({
      accessToken: 'tok',
      botId: 'bot',
      workspaceId: 'ws',
      workspaceName: 'Acme',
    })
    const [, init] = fetchImpl.mock.calls[0]
    expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /)
    expect(JSON.parse(init?.body as string)).toMatchObject({ grant_type: 'authorization_code', code: 'abc' })
  })

  it('throws on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 400 }))
    await expect(exchangeCodeForToken({ ...base, fetchImpl })).rejects.toThrow(/400/)
  })

  it('throws on a response missing required fields', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }))
    await expect(exchangeCodeForToken({ ...base, fetchImpl })).rejects.toThrow()
  })
})
