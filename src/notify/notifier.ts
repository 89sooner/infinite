import { hostname } from 'node:os'
import { basename } from 'node:path'
import type { Store } from '../store.ts'
import type { InfiniteConfig, Leg, RunState } from '../types.ts'
import type {
  Channel,
  ChannelStatus,
  DeliveryResult,
  NotificationsConfig,
  NotifyEventName,
  NotifyPayload,
  NotifySeverity,
} from './types.ts'
import { createChannel } from './channels.ts'

const SEVERITY_ORDER: Record<NotifySeverity, number> = { info: 0, warn: 1, error: 2 }

const EVENT_SEVERITY: Record<NotifyEventName, NotifySeverity> = {
  run_started: 'info',
  leg_started: 'info',
  handoff: 'info',
  leg_ended: 'info',
  run_complete: 'info',
  run_blocked: 'warn',
  run_stopped: 'warn',
  run_error: 'error',
  test: 'info',
}

export type NotifyContext = {
  leg?: Leg | null
  reason?: string | null
  extra?: string
}

/**
 * Fans lifecycle events out to configured channels. Delivery is fire-and-forget
 * from the caller's point of view: a messenger being down must never stall or
 * fail the agent run, so every failure is logged and swallowed.
 */
export class Notifier {
  private cfg: NotificationsConfig
  private store: Store
  private infiniteCfg: InfiniteConfig
  private channels: Channel[] = []
  private lastSentAt = new Map<string, number>()
  private lastResult = new Map<string, DeliveryResult>()
  private inFlight = new Set<Promise<void>>()

  constructor(infiniteCfg: InfiniteConfig, store: Store) {
    this.infiniteCfg = infiniteCfg
    this.cfg = infiniteCfg.notifications
    this.store = store

    for (const channelCfg of this.cfg.channels) {
      try {
        this.channels.push(createChannel(channelCfg))
      } catch (err) {
        this.store.error(
          'notify',
          `channel "${channelCfg.name}" could not be created: ${(err as Error).message}`,
        )
      }
    }

    if (this.cfg.enabled && this.channels.length === 0) {
      this.store.warn('notify', 'notifications are on but no channels are configured')
    }
  }

  // ------------------------------------------------------------- runtime state

  /** Global mute. Survives restarts because it lives in the persisted run state. */
  setMuted(muted: boolean): void {
    this.store.update((s) => {
      s.notifications.muted = muted
    })
    this.store.info('notify', muted ? 'notifications muted' : 'notifications unmuted')
  }

  setChannelEnabled(name: string, enabled: boolean): boolean {
    const known = this.channels.some((c) => c.name === name)
    if (!known) return false
    this.store.update((s) => {
      const off = new Set(s.notifications.disabledChannels)
      if (enabled) off.delete(name)
      else off.add(name)
      s.notifications.disabledChannels = [...off]
    })
    this.store.info('notify', `channel "${name}" ${enabled ? 'enabled' : 'disabled'}`)
    return true
  }

  /** Replaces the subscribed event set at runtime. */
  setEvents(events: NotifyEventName[]): void {
    this.store.update((s) => {
      s.notifications.events = events
    })
    this.store.info('notify', `subscribed events: ${events.join(', ') || '(none)'}`)
  }

  status(): ChannelStatus[] {
    const off = new Set(this.store.state.notifications.disabledChannels)
    return this.channels.map((c) => ({
      name: c.name,
      kind: c.kind,
      enabled: c.config.enabled,
      disabledAtRuntime: off.has(c.name),
      events: c.config.events ?? this.subscribedEvents(),
      lastResult: this.lastResult.get(c.name) ?? null,
      target: c.target(),
    }))
  }

  private subscribedEvents(): NotifyEventName[] {
    return this.store.state.notifications.events ?? this.cfg.events
  }

  // ------------------------------------------------------------------ dispatch

  /** Sends without waiting. Errors are logged, never thrown. */
  emit(event: NotifyEventName, ctx: NotifyContext = {}): void {
    const task = this.deliver(event, ctx).catch((err: unknown) => {
      this.store.error('notify', `dispatch failed: ${(err as Error).message}`)
    })
    this.inFlight.add(task)
    void task.finally(() => this.inFlight.delete(task))
  }

  /** Waits for in-flight deliveries so a shutdown does not cut the last message. */
  async drain(timeoutMs = 12_000): Promise<void> {
    if (this.inFlight.size === 0) return
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => {
        const t = setTimeout(resolve, timeoutMs)
        t.unref?.()
      }),
    ])
  }

  /** Used by `infinite notify-test`; reports per-channel outcomes to the caller. */
  async test(): Promise<DeliveryResult[]> {
    const payload = this.buildPayload('test', {
      extra: 'This is a test notification from infinite.',
    })
    const targets = this.channels.filter((c) => c.config.enabled)
    if (targets.length === 0) return []
    return Promise.all(targets.map((c) => this.sendTo(c, payload)))
  }

  private async deliver(event: NotifyEventName, ctx: NotifyContext): Promise<void> {
    if (!this.cfg.enabled) return
    if (this.store.state.notifications.muted) return

    const severity = EVENT_SEVERITY[event]
    if (SEVERITY_ORDER[severity] < SEVERITY_ORDER[this.cfg.minSeverity]) return
    if (!this.subscribedEvents().includes(event)) return

    const offAtRuntime = new Set(this.store.state.notifications.disabledChannels)
    const payload = this.buildPayload(event, ctx)

    const targets = this.channels.filter((c) => {
      if (!c.config.enabled || offAtRuntime.has(c.name)) return false
      const events = c.config.events
      if (events && events.length > 0 && !events.includes(event)) return false
      const min = c.config.minSeverity
      if (min && SEVERITY_ORDER[severity] < SEVERITY_ORDER[min]) return false
      return !this.throttled(c, event)
    })

    if (targets.length === 0) return
    await Promise.all(targets.map((c) => this.sendTo(c, payload)))
  }

  private throttled(channel: Channel, event: NotifyEventName): boolean {
    const window = (channel.config.minIntervalSec ?? 0) * 1000
    if (window <= 0) return false
    const key = `${channel.name}:${event}`
    const last = this.lastSentAt.get(key) ?? 0
    const now = Date.now()
    if (now - last < window) return true
    this.lastSentAt.set(key, now)
    return false
  }

  private async sendTo(channel: Channel, payload: NotifyPayload): Promise<DeliveryResult> {
    const retries = Math.max(0, channel.config.retries ?? 2)
    const started = Date.now()
    let detail = ''

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        await channel.send(payload)
        const result: DeliveryResult = {
          channel: channel.name,
          ok: true,
          detail: 'delivered',
          attempts: attempt,
          ms: Date.now() - started,
        }
        this.lastResult.set(channel.name, result)
        this.store.log('debug', 'notify', `sent ${payload.event} to "${channel.name}"`)
        return result
      } catch (err) {
        detail = (err as Error).message
        if (attempt <= retries) await sleep(1000 * 2 ** (attempt - 1))
      }
    }

    const result: DeliveryResult = {
      channel: channel.name,
      ok: false,
      detail,
      attempts: retries + 1,
      ms: Date.now() - started,
    }
    this.lastResult.set(channel.name, result)
    this.store.error('notify', `"${channel.name}" failed after ${retries + 1} tries: ${detail}`)
    return result
  }

  // ------------------------------------------------------------------- payload

  private buildPayload(event: NotifyEventName, ctx: NotifyContext): NotifyPayload {
    const s: RunState = this.store.state
    const leg = ctx.leg ?? null
    const ctxSnap = s.context
    const project = basename(this.infiniteCfg.cwd)
    const missionLine = firstMeaningfulLine(s.mission) ?? '(no mission loaded)'

    const { title, text } = describe(event, {
      project,
      leg,
      reason: ctx.reason ?? null,
      extra: ctx.extra,
      state: s,
    })

    return {
      event,
      severity: EVENT_SEVERITY[event],
      title,
      text,
      at: new Date().toISOString(),
      host: hostname(),
      project,
      mission: missionLine,
      status: s.status,
      leg: leg?.n ?? (s.currentLeg || null),
      legOutcome: leg?.outcome ?? null,
      legSummary: leg?.summary ?? null,
      reason: ctx.reason ?? leg?.reason ?? null,
      contextPct: ctxSnap ? Math.round(ctxSnap.pct * 1000) / 10 : null,
      contextTokens: ctxSnap?.tokens ?? null,
      contextMaxTokens: ctxSnap?.maxTokens ?? null,
      totalCostUsd: Math.round(s.totalCostUsd * 100) / 100,
      totalTurns: s.totalTurns,
      totalLegs: s.legs.length,
      dashboardUrl: this.cfg.dashboardUrl,
    }
  }
}

type DescribeInput = {
  project: string
  leg: Leg | null
  reason: string | null
  extra?: string
  state: RunState
}

function describe(event: NotifyEventName, i: DescribeInput): { title: string; text: string } {
  const tag = `[infinite/${i.project}]`
  const spend = `$${i.state.totalCostUsd.toFixed(2)}`
  const legNo = i.leg?.n ?? i.state.currentLeg

  switch (event) {
    case 'run_started':
      return {
        title: `${tag} run started`,
        text: `Mission: ${firstMeaningfulLine(i.state.mission) ?? '(none)'}\nResuming at session ${i.state.legs.length + 1}.`,
      }
    case 'leg_started':
      return {
        title: `${tag} session ${legNo} started`,
        text:
          legNo > 1
            ? `A fresh session took over from session ${legNo - 1} and is continuing from its handoff.`
            : 'First session started.',
      }
    case 'handoff':
      return {
        title: `${tag} session ${legNo} handing off`,
        text:
          `Reason: ${i.reason ?? 'context threshold'}.\n` +
          `Context ${pctText(i.state)}. A handoff document is being written; ` +
          `a new session will continue from it.`,
      }
    case 'leg_ended':
      return {
        title: `${tag} session ${legNo} ended (${i.leg?.outcome ?? 'unknown'})`,
        text:
          `${i.leg?.turns ?? 0} turns, $${(i.leg?.costUsd ?? 0).toFixed(2)}. ` +
          `${i.leg?.summary ?? i.leg?.reason ?? ''}`.trim(),
      }
    case 'run_complete':
      return {
        title: `${tag} mission COMPLETE`,
        text: `Finished after ${i.state.legs.length} sessions, ${i.state.totalTurns} turns, ${spend}.`,
      }
    case 'run_blocked':
      return {
        title: `${tag} run BLOCKED — needs a human`,
        text: `${i.reason ?? 'The agent reported it cannot proceed.'}\nStopped after ${i.state.legs.length} sessions, ${spend}.`,
      }
    case 'run_stopped':
      return {
        title: `${tag} run stopped`,
        text: `${i.reason ?? 'Stopped.'}\n${i.state.legs.length} sessions, ${i.state.totalTurns} turns, ${spend}.`,
      }
    case 'run_error':
      return {
        title: `${tag} run FAILED`,
        text: `${i.reason ?? i.state.lastError ?? 'Unknown error.'}\nAfter ${i.state.legs.length} sessions, ${spend}.`,
      }
    case 'test':
      return {
        title: `${tag} test notification`,
        text: i.extra ?? 'Test.',
      }
  }
}

function pctText(s: RunState): string {
  if (!s.context) return 'unknown'
  return `${(s.context.pct * 100).toFixed(1)}% (${s.context.tokens.toLocaleString()} / ${s.context.maxTokens.toLocaleString()})`
}

function firstMeaningfulLine(text: string): string | null {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('<!--'))
  if (!line) return null
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
