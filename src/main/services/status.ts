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
