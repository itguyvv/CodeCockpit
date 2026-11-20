/** Structured session status, aggregated from each engine's storage (claude jsonl / openCode JSON) */
export interface SessionStatus {
  model: string
  /** Tool name of the most recent invocation */
  tool: string | null
  /** Tool input summary (command / file path etc., ≤80 chars) */
  toolDetail: string
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  /** Estimated from the API pricing table (claude) / reported by the provider (openCode) */
  costUsd: number
  turns: number
  toolCalls: number
  toolCounts: Record<string, number>
  durationMs: number
  lastActivity: number
  eventCount: number
  /** Background shells the agent launched and that have not finished yet (claude only) */
  backgroundTasks: number
  /** Latest plan list (claude TodoWrite / codex update_plan / openCode todowrite), if any */
  todos?: TodoItem[]
}

export interface TodoItem {
  content: string
  status: string
  activeForm?: string
}

/** Normalize an engine's todo payload into TodoItem[]; returns undefined when unusable */
export function normalizeTodos(raw: unknown): TodoItem[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: TodoItem[] = []
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    const content = typeof o.content === 'string' ? o.content : typeof o.step === 'string' ? o.step : ''
    if (!content) continue
    out.push({
      content,
      status: typeof o.status === 'string' ? o.status : 'pending',
      activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined
    })
  }
  return out.length > 0 ? out : undefined
}

export function emptyStatus(): SessionStatus {
  return {
    model: '',
    tool: null,
    toolDetail: '',
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    turns: 0,
    toolCalls: 0,
    toolCounts: {},
    durationMs: 0,
    lastActivity: 0,
    eventCount: 0,
    backgroundTasks: 0
  }
}
