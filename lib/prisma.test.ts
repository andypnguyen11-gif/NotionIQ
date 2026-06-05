import { describe, it, expect } from 'vitest'
import { createPrismaSingleton } from './prisma'

describe('createPrismaSingleton', () => {
  it('returns the same instance across calls (caches on the provided global ref)', () => {
    const globalRef: { prisma?: unknown } = {}
    const factory = () => ({ id: Math.random() })
    const a = createPrismaSingleton(globalRef, factory)
    const b = createPrismaSingleton(globalRef, factory)
    expect(a).toBe(b)
  })

  it('builds a new instance when the global ref is empty', () => {
    const globalRef: { prisma?: unknown } = {}
    const instance = createPrismaSingleton(globalRef, () => ({ id: 1 }))
    expect(instance).toBeDefined()
    expect(globalRef.prisma).toBe(instance)
  })
})
