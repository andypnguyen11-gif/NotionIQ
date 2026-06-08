import Anthropic from '@anthropic-ai/sdk'

export interface ToolCallResult {
  input: unknown
  model: string
  inputTokens: number
  outputTokens: number
}

export interface ToolCaller {
  callTool(args: {
    system: string
    user: string
    toolName: string
    toolSchema: object
    model: string
  }): Promise<ToolCallResult>
}

// Thin wrapper around the Anthropic SDK that forces a single tool call and returns its
// validated-elsewhere input plus token usage. `sdk` is injected so tests never hit the network.
export function createToolCaller(opts: { sdk: Pick<Anthropic, 'messages'> }): ToolCaller {
  return {
    async callTool({ system, user, toolName, toolSchema, model }) {
      const res = await opts.sdk.messages.create({
        model,
        max_tokens: 2048,
        system,
        messages: [{ role: 'user', content: user }],
        tools: [{ name: toolName, description: 'Return the mapping.', input_schema: toolSchema as never }],
        tool_choice: { type: 'tool', name: toolName },
      } as never)
      const block = (res.content as { type: string; name?: string; input?: unknown }[]).find(
        (b) => b.type === 'tool_use',
      )
      if (!block) throw new Error('Anthropic returned no tool_use block')
      return {
        input: block.input,
        model: res.model,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      }
    },
  }
}

export function createAnthropicSdk(apiKey: string): Pick<Anthropic, 'messages'> {
  return new Anthropic({ apiKey })
}
