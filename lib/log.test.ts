import { describe, it, expect, vi, afterEach } from 'vitest'
import { log } from './log'

afterEach(() => vi.restoreAllMocks())

describe('log', () => {
  it('emits a single JSON line with level, event, and fields to stdout for info', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.info('notion_connected', { userId: 'user_123', notionWorkspaceId: 'ws_1' })
    expect(spy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed).toMatchObject({
      level: 'info',
      event: 'notion_connected',
      userId: 'user_123',
      notionWorkspaceId: 'ws_1',
    })
  })

  it('routes error events to stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    log.error('notion_oauth_exchange_failed', { userId: 'user_123' })
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed).toMatchObject({ level: 'error', event: 'notion_oauth_exchange_failed' })
  })

  it('emits event with no fields when none are given', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    log.warn('notion_oauth_state_invalid')
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed).toEqual({ level: 'warn', event: 'notion_oauth_state_invalid' })
  })
})
