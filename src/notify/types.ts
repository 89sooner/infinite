import type { RunStatus } from '../types.ts'

/** Lifecycle moments an operator may want pushed to a messenger. */
export type NotifyEventName =
  | 'run_started'
  | 'leg_started' // a fresh session took over — the "restart" event
  | 'handoff' // a session hit its threshold and wrote a handoff
  | 'leg_ended'
  | 'run_complete'
  | 'run_blocked'
  | 'run_stopped'
  | 'run_error'
  | 'test'

export const ALL_EVENTS: NotifyEventName[] = [
  'run_started',
  'leg_started',
  'handoff',
  'leg_ended',
  'run_complete',
  'run_blocked',
  'run_stopped',
  'run_error',
  'test',
]

export type NotifySeverity = 'info' | 'warn' | 'error'

/**
 * Everything a channel is allowed to see. Flat and JSON-safe on purpose: any
 * field here can be referenced as `{{field}}` in a channel body template, which
 * is what lets a new messenger be added by configuration alone.
 */
export type NotifyPayload = {
  event: NotifyEventName
  severity: NotifySeverity
  /** One line, suitable as a message subject. */
  title: string
  /** A few lines of detail, already human-readable. */
  text: string
  at: string
  host: string
  project: string
  mission: string
  status: RunStatus
  leg: number | null
  legOutcome: string | null
  legSummary: string | null
  reason: string | null
  contextPct: number | null
  contextTokens: number | null
  contextMaxTokens: number | null
  totalCostUsd: number
  totalTurns: number
  totalLegs: number
  dashboardUrl: string | null
}

export type ChannelKind = 'webhook' | 'knox' | 'command'

export type ChannelConfigBase = {
  /** Stable identifier used by the mute/enable API and the dashboard. */
  name: string
  kind: ChannelKind
  /** Off means this channel never fires, even when explicitly enabled at runtime. */
  enabled: boolean
  /** Subscribe to a subset of events. Empty or absent means "the global set". */
  events?: NotifyEventName[]
  /** Drop events below this severity. */
  minSeverity?: NotifySeverity
  /** Suppress repeats within this many seconds (per event name). 0 disables. */
  minIntervalSec?: number
  timeoutMs?: number
  retries?: number
}

export type WebhookChannelConfig = ChannelConfigBase & {
  kind: 'webhook' | 'knox'
  url: string
  method?: string
  headers?: Record<string, string>
  /**
   * JSON body sent to the endpoint. Any string inside it (at any depth) may use
   * `{{field}}` placeholders drawn from NotifyPayload. Omit to send the whole
   * payload as-is.
   */
  bodyTemplate?: unknown
}

export type CommandChannelConfig = ChannelConfigBase & {
  kind: 'command'
  /** Executable to run. Not passed through a shell. */
  command: string
  /** Arguments, each supporting `{{field}}` placeholders. */
  args?: string[]
  /** The JSON payload is written to the process stdin unless this is false. */
  stdin?: boolean
}

export type ChannelConfig = WebhookChannelConfig | CommandChannelConfig

export type NotificationsConfig = {
  enabled: boolean
  /** Default subscription for channels that do not narrow it themselves. */
  events: NotifyEventName[]
  minSeverity: NotifySeverity
  /** Included in payloads so a message can link back to the dashboard. */
  dashboardUrl: string | null
  channels: ChannelConfig[]
}

export type DeliveryResult = {
  channel: string
  ok: boolean
  detail: string
  attempts: number
  ms: number
}

/** What the dashboard is allowed to know — never credentials. */
export type ChannelStatus = {
  name: string
  kind: ChannelKind
  /** From configuration. */
  enabled: boolean
  /** Turned off at runtime through the API. */
  disabledAtRuntime: boolean
  events: NotifyEventName[]
  lastResult: DeliveryResult | null
  target: string
}

export interface Channel {
  readonly name: string
  readonly kind: ChannelKind
  readonly config: ChannelConfig
  /** A redacted description of where this sends, safe to show in the UI. */
  target(): string
  send(payload: NotifyPayload): Promise<void>
}
