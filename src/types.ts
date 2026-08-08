import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import type { NotificationsConfig, NotifyEventName } from './notify/types.ts'

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
  /** Output budget reserved inside the same window; shrinks the usable share. */
  maxOutputTokens: number | null
  /** The configured threshold after clamping to what this session can reach. */
  effectiveThreshold: number
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
  /** Runtime notification controls, persisted so they survive a restart. */
  notifications: NotificationRuntime
}

export type NotificationRuntime = {
  /** Global off switch, toggled from the dashboard or the API. */
  muted: boolean
  /** Channels switched off at runtime, by name. */
  disabledChannels: string[]
  /** Subscribed events; seeded from config on first run. */
  events: NotifyEventName[]
}

export type ToolPolicy = {
  /** Tool names always allowed without asking. */
  allowTools: string[]
  /** Tool names always denied. */
  denyTools: string[]
  /** Bash command prefixes allowed, matched per segment at a word boundary. */
  allowBash: string[]
  /** Command prefixes that force a denial, checked before allowBash. */
  denyBash: string[]
  /**
   * Paths that destructive commands (rm, rmdir, shred, mv, chmod, chown) may
   * never target, directly or by containing them. `~` is expanded. The working
   * directory and its ancestors are always protected in addition to these.
   */
  protectedPaths: string[]
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
   * only thing that fires. Defaults to true: compaction triggers mid-turn while
   * the threshold is checked between turns, so leaving it on means it wins the
   * race and no handoff is ever written. Set false only if you want compaction
   * as a safety net and accept that it may preempt the handoff.
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

  notifications: NotificationsConfig
}

export type { NotificationsConfig, NotifyEventName } from './notify/types.ts'
