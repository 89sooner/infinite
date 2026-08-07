import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { Event, EventLevel, InfiniteConfig, RunState } from './types.ts'

const MAX_EVENTS_IN_MEMORY = 400

/**
 * Holds the run state, persists it atomically, appends an audit log, and emits
 * change notifications the dashboard subscribes to over SSE.
 */
export class Store extends EventEmitter {
  readonly cfg: InfiniteConfig
  readonly stateFile: string
  readonly logFile: string
  readonly handoffDir: string
  state: RunState

  private flushTimer: NodeJS.Timeout | null = null
  private quiet: boolean

  constructor(cfg: InfiniteConfig, opts: { quiet?: boolean } = {}) {
    super()
    this.setMaxListeners(0)
    this.cfg = cfg
    this.quiet = opts.quiet ?? false
    this.handoffDir = join(cfg.stateDir, 'handoffs')
    this.stateFile = join(cfg.stateDir, 'state.json')
    this.logFile = join(cfg.stateDir, 'events.jsonl')
    mkdirSync(this.handoffDir, { recursive: true })
    this.state = this.readState()
  }

  private readState(): RunState {
    if (existsSync(this.stateFile)) {
      try {
        const prev = JSON.parse(readFileSync(this.stateFile, 'utf8')) as RunState
        // A run that was killed mid-flight should not claim to be running.
        if (prev.status === 'running' || prev.status === 'stopping') prev.status = 'stopped'
        // State written before notifications existed, or by an older version.
        prev.notifications = {
          muted: prev.notifications?.muted ?? false,
          disabledChannels: prev.notifications?.disabledChannels ?? [],
          events: prev.notifications?.events ?? this.cfg.notifications.events,
        }
        return prev
      } catch {
        // Corrupt state should not block a restart; keep it for forensics.
        try {
          renameSync(this.stateFile, `${this.stateFile}.corrupt-${Date.now()}`)
        } catch {
          /* best effort */
        }
      }
    }
    return {
      status: 'idle',
      startedAt: null,
      updatedAt: new Date().toISOString(),
      missionPath: this.cfg.missionFile,
      mission: '',
      currentLeg: 0,
      legs: [],
      tasks: [],
      context: null,
      totalCostUsd: 0,
      totalTurns: 0,
      handoffRequested: false,
      lastError: null,
      notifications: {
        muted: false,
        disabledChannels: [],
        events: this.cfg.notifications.events,
      },
    }
  }

  /** Mutate state through this so persistence and subscribers stay in sync. */
  update(fn: (s: RunState) => void): void {
    fn(this.state)
    this.state.updatedAt = new Date().toISOString()
    this.emit('state', this.state)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, 250)
    this.flushTimer.unref?.()
  }

  flush(): void {
    const tmp = `${this.stateFile}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      renameSync(tmp, this.stateFile)
    } catch (err) {
      process.stderr.write(`[infinite] could not persist state: ${(err as Error).message}\n`)
    }
  }

  log(level: EventLevel, kind: string, msg: string, data?: unknown): Event {
    const ev: Event = { ts: new Date().toISOString(), level, kind, msg }
    if (data !== undefined) ev.data = data

    try {
      appendFileSync(this.logFile, `${JSON.stringify(ev)}\n`)
    } catch {
      /* the log is a convenience, never a hard dependency */
    }

    this.emit('event', ev)
    if (!this.quiet) process.stdout.write(format(ev))
    return ev
  }

  info(kind: string, msg: string, data?: unknown) {
    return this.log('info', kind, msg, data)
  }
  warn(kind: string, msg: string, data?: unknown) {
    return this.log('warn', kind, msg, data)
  }
  error(kind: string, msg: string, data?: unknown) {
    return this.log('error', kind, msg, data)
  }

  /** Recent events, newest last. Read from the audit log so restarts keep history. */
  recentEvents(limit = MAX_EVENTS_IN_MEMORY): Event[] {
    if (!existsSync(this.logFile)) return []
    let lines: string[]
    try {
      lines = readFileSync(this.logFile, 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as Event
        } catch {
          return null
        }
      })
      .filter((e): e is Event => e !== null)
  }

  handoffPath(leg: number): string {
    return join(this.handoffDir, `leg-${String(leg).padStart(3, '0')}.md`)
  }

  readHandoff(leg: number): string | null {
    const p = this.handoffPath(leg)
    if (!existsSync(p)) return null
    try {
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  }
}

const COLORS: Record<EventLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
}

function format(ev: Event): string {
  const useColor = process.stdout.isTTY === true
  const time = ev.ts.slice(11, 19)
  const tag = `[${ev.kind}]`
  if (!useColor) return `${time} ${tag} ${ev.msg}\n`
  return `\x1b[90m${time}\x1b[0m ${COLORS[ev.level]}${tag}\x1b[0m ${ev.msg}\n`
}
