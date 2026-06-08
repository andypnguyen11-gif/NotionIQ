import { describe, it, expect, vi } from 'vitest'
import { createToolCaller } from './anthropic-client'

describe('createToolCaller', () => {
  it('forces tool use and returns the tool input + usage', async () => {
    const create = vi.fn(async () => ({
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [{ type: 'tool_use', name: 'emit_mapping', input: { ok: true } }],
    }))
    const caller = createToolCaller({ sdk: { messages: { create } } as never })
    const res = await caller.callTool({
      system: 'sys', user: 'usr', toolName: 'emit_mapping', toolSchema: { type: 'object' }, model: 'claude-sonnet-4-6',
    })
    expect(res.input).toEqual({ ok: true })
    expect(res.inputTokens).toBe(10)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ tool_choice: { type: 'tool', name: 'emit_mapping' } }),
    )
  })

  it('throws if no tool_use block is returned', async () => {
    const create = vi.fn(async () => ({ model: 'm', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'hi' }] }))
    const caller = createToolCaller({ sdk: { messages: { create } } as never })
    await expect(
      caller.callTool({ system: 's', user: 'u', toolName: 't', toolSchema: {}, model: 'm' }),
    ).rejects.toThrow(/tool_use/)
  })
})
