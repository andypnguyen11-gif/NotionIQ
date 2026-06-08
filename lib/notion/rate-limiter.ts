// Token-bucket-ish limiter (serializes acquires to >= 1/ratePerSec apart) plus a
// retry-with-exponential-backoff helper for 429/5xx. Clock + sleep are injectable so
// tests are deterministic and fast.
export interface RateLimiter {
  acquire(): Promise<void>
}

export function createRateLimiter(opts: {
  ratePerSec: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): RateLimiter {
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const minGapMs = 1000 / opts.ratePerSec
  let nextAllowed = 0
  let chain: Promise<void> = Promise.resolve()
  return {
    acquire() {
      chain = chain.then(async () => {
        const wait = nextAllowed - now()
        if (wait > 0) await sleep(wait)
        nextAllowed = now() + minGapMs
      })
      return chain
    },
  }
}

function statusOf(err: unknown): number | undefined {
  return typeof err === 'object' && err !== null && 'status' in err
    ? (err as { status?: number }).status
    : undefined
}

export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: { retries: number; baseMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      const status = statusOf(err)
      const retryable = status === 429 || (status !== undefined && status >= 500)
      if (!retryable || attempt >= opts.retries) throw err
      await sleep(opts.baseMs * 2 ** attempt)
      attempt++
    }
  }
}
