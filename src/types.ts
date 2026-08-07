import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk'

/** Why a leg (one Claude Code session) ended. */
export type LegOutcome =
  | 'running'
  | 'handoff' // context/turn/budget threshold reached, handoff written, next leg follows
  | 'complete' // agent declared the mission finished
  | 'blocked' // agent declared it cannot proceed
  | 'stopped' // operator stopped the run
  | 'error'

export type Leg = {
  n: number
  sessionId: string | null
  startedAt: string
  endedAt: string | null
  turns: number
  costUsd: number
  /** Context usage at the moment the leg ended. */
  contextTokens: number
  contextMaxTokens: number
  contextPct: number
  outcome: LegOutcome
  /** One-line progress note carried into every later leg. */
  summary: string | null
  handoffFile: string | null
  reason: string | null
}

export type Task = {
  id: string
  text: string
  addedAt: string
  status: 'pending' | 'sent' | 'done'
  sentInLeg: number | null
}

export type ContextSnapshot = {
  tokens: number
  maxTokens: number
  pct: number
  model: string
  /** Claude Code's own auto-compact threshold, for reference. */
  autoCompactThreshold: number | null
  autoCompactEnabled: boolean
  categories: { name: string; tokens: number }[]
  at: string
}

export type EventLevel = 'debug' | 'info' | 'warn' | 'error'

export type Event = {
  ts: string
  level: EventLevel
  kind: string
  msg: string
  data?: unknown
}

export type RunStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'complete'
  | 'blocked'
  | 'error'

export type RunState = {
  status: RunStatus
  startedAt: string | null
  updatedAt: string
  missionPath: string
  mission: string
  currentLeg: number
  legs: Leg[]
  tasks: Task[]
  context: ContextSnapshot | null
  totalCostUsd: number
  totalTurns: number
  /** Set when the operator asks for a handoff before the threshold is hit. */
  handoffRequested: boolean
  lastError: string | null
}

export type ToolPolicy = {
  /** Tool names always allowed without asking. */
  allowTools: string[]
  /** Tool names always denied. */
  denyTools: string[]
  /** Bash command prefixes allowed (matched against the start of the command). */
  allowBash: string[]
  /** Bash substrings that force a denial, checked before allowBash. */
  denyBash: string[]
  /** What to do when nothing matched: 'allow' is unattended-permissive, 'deny' is safe. */
  fallback: 'allow' | 'deny'
}

export type InfiniteConfig = {
  /** Working directory the agent operates in. */
  cwd: string
  /** Path to the mission file, carried verbatim into every leg. */
  missionFile: string
  /** Where state, handoffs and logs are written. */
  stateDir: string

  /** Fraction of the context window that triggers a handoff (0-1). */
  handoffThreshold: number
  /** Hard ceiling on legs; 0 means unlimited. */
  maxLegs: number
  /** Turns after which a leg hands off regardless of context. 0 disables. */
  maxTurnsPerLeg: number
  /** USD spend after which a leg hands off. 0 disables. */
  maxCostUsdPerLeg: number
  /** USD spend after which the whole run stops. 0 disables. */
  maxCostUsdTotal: number
  /** Seconds to wait before starting the next leg. */
  legCooldownSec: number

  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
  toolPolicy: ToolPolicy
  allowedTools: string[] | null
  disallowedTools: string[] | null
  additionalDirectories: string[]

  /**
   * Turn off Claude Code's own auto-compaction so the handoff threshold is the
   * only thing that fires. Leaving it on keeps compaction as a safety net.
   */
  disableAutoCompact: boolean

  /** Sent when the agent has no queued task but the mission is unfinished. */
  idleNudge: string
  /** Stop the whole run when the agent reports BLOCKED, instead of nudging on. */
  stopOnBlocked: boolean

  server: {
    enabled: boolean
    host: string
    port: number
    /** Bearer token required for mutating API calls. */
    token: string | null
  }
}
