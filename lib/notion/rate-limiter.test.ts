import { describe, it, expect } from 'vitest'
import { createRateLimiter, withBackoff } from './rate-limiter'

describe('createRateLimiter', () => {
  it('spaces calls to at most the configured rate using injected clock + sleep', async () => {
    let now = 0
    const sleeps: number[] = []
    const limiter = createRateLimiter({
      ratePerSec: 3,
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms },
    })
    await limiter.acquire() // first is immediate
    await limiter.acquire() // must wait ~333ms
    expect(sleeps[0]).toBeGreaterThanOrEqual(300)
  })
})

describe('withBackoff', () => {
  it('retries on a thrown 429 then succeeds', async () => {
    const sleeps: number[] = []
    let calls = 0
    const result = await withBackoff(
      async () => {
        calls++
        if (calls < 2) throw Object.assign(new Error('rate limited'), { status: 429 })
        return 'ok'
      },
      { retries: 3, baseMs: 100, sleep: async (ms) => { sleeps.push(ms) } },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(2)
    expect(sleeps.length).toBe(1)
  })

  it('gives up after retries are exhausted and rethrows', async () => {
    await expect(
      withBackoff(
        async () => { throw Object.assign(new Error('boom'), { status: 500 }) },
        { retries: 1, baseMs: 1, sleep: async () => {} },
      ),
    ).rejects.toThrow('boom')
  })
})
