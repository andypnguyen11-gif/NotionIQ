// Structured, secret-free application logging. Emit only non-sensitive identifiers
// (Clerk user ids, Notion workspace ids, event names) — NEVER tokens, codes, secrets, or PII.
type LogLevel = 'info' | 'warn' | 'error'
type LogFields = Record<string, string | number | boolean | null | undefined>

function emit(level: LogLevel, event: string, fields?: LogFields): void {
  const line = JSON.stringify({ level, event, ...(fields ?? {}) })
  if (level === 'error') {
    console.error(line)
  } else {
    console.log(line)
  }
}

export const log = {
  info: (event: string, fields?: LogFields) => emit('info', event, fields),
  warn: (event: string, fields?: LogFields) => emit('warn', event, fields),
  error: (event: string, fields?: LogFields) => emit('error', event, fields),
}
