import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type {
  Options,
  Query,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SDKControlGetContextUsageResponse,
} from '@anthropic-ai/claude-agent-sdk'
import type { Store } from './store.ts'
import type { ContextSnapshot, InfiniteConfig, Leg } from './types.ts'
import {
  buildHandoffPrompt,
  buildLegPrompt,
  parseStatus,
  parseSummary,
  salvageHandoff,
} from './handoff.ts'
import { buildPermissionHandler } from './policy.ts'
import { Notifier } from './notify/notifier.ts'
import { effectiveHandoffThreshold, pickMaxOutputTokens } from './threshold.ts'

/**
 * A push-driven async iterable of user messages. The SDK consumes it for the
 * lifetime of a leg; we push a new message after each completed turn and close
 * it to end the session cleanly.
 */
class InputStream implements AsyncIterable<SDKUserMessage> {
  private pending: SDKUserMessage[] = []
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null
  private closed = false

  push(text: string): void {
    if (this.closed) return
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    }
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: msg, done: false })
    } else {
      this.pending.push(msg)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined as never, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      if (this.pending.length > 0) {
        yield this.pending.shift() as SDKUserMessage
        continue
      }
      if (this.closed) return
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiting = resolve
      })
      if (next.done) return
      yield next.value
    }
  }
}

type HandoffReason = 'context' | 'turns' | 'cost' | 'operator'

type LegResult = {
  leg: Leg
  /** Whether the run should continue with another leg. */
  continueRun: boolean
}

export class Orchestrator {
  private cfg: InfiniteConfig
  private store: Store
  private abort: AbortController | null = null
  private stopRequested = false
  private pauseRequested = false
  private activeQuery: Query | null = null
  /** Output budget of the running model, learned from the first result. */
  private maxOutputTokens: number | null = null
  /** The configured threshold after clamping to what this session can reach. */
  private threshold: number
  /** Threshold value already warned about, so the same clamp is not re-logged. */
  private thresholdReported: number | null = null
  /** Largest window share a single turn has added, measured across the run. */
  private turnGrowth: number | null = null
  /** Context share at the end of the previous turn of the current leg. */
  private lastPct: number | null = null
  readonly notifier: Notifier

  constructor(cfg: InfiniteConfig, store: Store) {
    this.cfg = cfg
    this.store = store
    this.threshold = cfg.handoffThreshold
    this.notifier = new Notifier(cfg, store)
  }

  // ---------------------------------------------------------------- controls

  requestHandoff(): void {
    this.store.update((s) => {
      s.handoffRequested = true
    })
    this.store.info('control', 'handoff requested by operator')
  }

  pause(): void {
    this.pauseRequested = true
    this.store.update((s) => {
      if (s.status === 'running') s.status = 'paused'
    })
    this.store.info('control', 'paused — will hold after the current turn')
  }

  resume(): void {
    this.pauseRequested = false
    this.store.update((s) => {
      if (s.status === 'paused') s.status = 'running'
    })
    this.store.info('control', 'resumed')
  }

  stop(): void {
    this.stopRequested = true
    this.pauseRequested = false
    this.store.update((s) => {
      s.status = 'stopping'
    })
    this.store.info('control', 'stop requested — ending after the current turn')
    this.abort?.abort()
  }

  addTask(text: string): void {
    this.store.update((s) => {
      s.tasks.push({
        id: randomUUID(),
        text,
        addedAt: new Date().toISOString(),
        status: 'pending',
        sentInLeg: null,
      })
    })
    this.store.info('task', `queued: ${text.slice(0, 120)}`)
  }

  // -------------------------------------------------------------- main loop

  async run(): Promise<void> {
    const mission = this.loadMission()

    this.store.update((s) => {
      s.status = 'running'
      s.startedAt = s.startedAt ?? new Date().toISOString()
      s.mission = mission
      s.missionPath = this.cfg.missionFile
      s.lastError = null
      s.handoffRequested = false
    })

    this.store.info(
      'run',
      `starting — handoff at ${Math.round(this.cfg.handoffThreshold * 100)}% context, ` +
        `resuming from leg ${this.store.state.legs.length + 1}`,
    )
    this.notifier.emit('run_started')

    try {
      for (;;) {
        if (this.stopRequested) break

        const legNumber = this.store.state.legs.length + 1
        if (this.cfg.maxLegs > 0 && legNumber > this.cfg.maxLegs) {
          this.store.warn('run', `reached maxLegs (${this.cfg.maxLegs}) — stopping`)
          this.setTerminal('stopped', `Reached the ${this.cfg.maxLegs}-session limit.`)
          return
        }
        if (
          this.cfg.maxCostUsdTotal > 0 &&
          this.store.state.totalCostUsd >= this.cfg.maxCostUsdTotal
        ) {
          this.store.warn(
            'run',
            `total spend $${this.store.state.totalCostUsd.toFixed(2)} reached the ` +
              `$${this.cfg.maxCostUsdTotal} cap — stopping`,
          )
          this.setTerminal(
            'stopped',
            `Total spend reached the $${this.cfg.maxCostUsdTotal} cap.`,
          )
          return
        }

        const { leg, continueRun } = await this.runLeg(legNumber, mission)

        if (!continueRun) {
          const terminal =
            leg.outcome === 'complete'
              ? 'complete'
              : leg.outcome === 'blocked'
                ? 'blocked'
                : leg.outcome === 'error'
                  ? 'error'
                  : 'stopped'
          this.setTerminal(terminal, leg.reason)
          return
        }

        if (this.cfg.legCooldownSec > 0 && !this.stopRequested) {
          await sleep(this.cfg.legCooldownSec * 1000)
        }
      }
      this.setTerminal('stopped')
    } catch (err) {
      const msg = (err as Error).message
      this.store.error('run', `run failed: ${msg}`)
      this.store.update((s) => {
        s.status = 'error'
        s.lastError = msg
      })
      this.notifier.emit('run_error', { reason: msg })
    } finally {
      this.store.flush()
      // Hold the process open just long enough for the final message to land.
      await this.notifier.drain()
    }
  }

  private setTerminal(
    status: 'complete' | 'blocked' | 'stopped' | 'error',
    reason?: string | null,
  ): void {
    this.store.update((s) => {
      s.status = status
    })
    this.store.info('run', `run finished with status "${status}"`)

    const event =
      status === 'complete'
        ? 'run_complete'
        : status === 'blocked'
          ? 'run_blocked'
          : status === 'error'
            ? 'run_error'
            : 'run_stopped'
    this.notifier.emit(event, { reason: reason ?? null })
  }

  private loadMission(): string {
    if (!existsSync(this.cfg.missionFile)) {
      throw new Error(
        `Mission file not found: ${this.cfg.missionFile}\n` +
          `Write the mission there, or point missionFile at it in infinite.config.json.`,
      )
    }
    const text = readFileSync(this.cfg.missionFile, 'utf8').trim()
    if (!text) throw new Error(`Mission file is empty: ${this.cfg.missionFile}`)
    return text
  }

  // ------------------------------------------------------------------- a leg

  private async runLeg(legNumber: number, mission: string): Promise<LegResult> {
    const leg: Leg = {
      n: legNumber,
      sessionId: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      turns: 0,
      costUsd: 0,
      contextTokens: 0,
      contextMaxTokens: 0,
      contextPct: 0,
      outcome: 'running',
      summary: null,
      handoffFile: null,
      reason: null,
    }

    this.store.update((s) => {
      s.currentLeg = legNumber
      s.handoffRequested = false
    })
    // A new leg starts from a fresh context, so the first turn's jump is fixed
    // cost rather than growth. Measured growth itself carries over — it is a
    // property of the workload, not of one session.
    this.lastPct = null
    this.store.info('leg', `session ${legNumber} starting`)
    this.notifier.emit('leg_started', { leg })

    const previousHandoff = legNumber > 1 ? this.store.readHandoff(legNumber - 1) : null
    if (legNumber > 1 && !previousHandoff) {
      this.store.warn('leg', `no handoff found for session ${legNumber - 1}`)
    }

    const pendingTasks = this.store.state.tasks.filter((t) => t.status === 'pending')
    const prompt = buildLegPrompt({
      legNumber,
      mission,
      previousHandoff,
      progressLog: this.store.state.legs,
      tasks: pendingTasks.map((t) => t.text),
      thresholdPct: this.cfg.handoffThreshold,
    })
    this.store.update((s) => {
      for (const t of s.tasks) {
        if (t.status === 'pending') {
          t.status = 'sent'
          t.sentInLeg = legNumber
        }
      }
    })

    this.abort = new AbortController()
    const input = new InputStream()
    const q = query({ prompt: input, options: this.buildOptions() })
    this.activeQuery = q

    input.push(prompt)

    let awaitingHandoff = false
    let handoffReason: HandoffReason = 'context'
    let lastText = ''
    let finalStatus: ReturnType<typeof parseStatus> = { status: null, reason: null }

    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'compact_boundary') {
          this.store.warn(
            'compact',
            'Claude Code auto-compacted before the handoff threshold fired — ' +
              'consider lowering handoffThreshold or setting disableAutoCompact',
          )
          continue
        }

        if (msg.type === 'assistant') {
          const text = extractText(msg.message?.content)
          if (text) lastText = text
          continue
        }

        if (msg.type !== 'result') continue

        const result = msg as SDKResultMessage
        leg.sessionId = result.session_id
        leg.turns += 1
        leg.costUsd = result.total_cost_usd
        const resultText = 'result' in result ? result.result : ''
        if (resultText) lastText = resultText

        this.maxOutputTokens =
          pickMaxOutputTokens(result.modelUsage, this.cfg.model) ?? this.maxOutputTokens

        this.store.update((s) => {
          s.totalTurns += 1
        })
        this.recomputeTotalCost(leg)

        if (result.is_error || result.subtype !== 'success') {
          const detail = describeFailure(result)
          this.store.error('leg', `session ${legNumber} turn failed — ${detail}`)
          leg.outcome = 'error'
          leg.reason = detail
          input.close()
          break
        }

        const usage = await this.readContext(q)
        if (usage) {
          leg.contextTokens = usage.tokens
          leg.contextMaxTokens = usage.maxTokens
          leg.contextPct = usage.pct
        }

        this.store.info(
          'turn',
          `session ${legNumber} turn ${leg.turns} — ` +
            `context ${usage ? `${(usage.pct * 100).toFixed(1)}%` : 'unknown'}, ` +
            `$${leg.costUsd.toFixed(3)}`,
        )

        // The handoff turn itself is the last one in the leg.
        if (awaitingHandoff) {
          leg.summary = parseSummary(lastText) ?? firstLine(lastText)
          leg.handoffFile = this.persistHandoff(legNumber, lastText)
          leg.outcome = 'handoff'
          leg.reason = handoffReason
          input.close()
          break
        }

        finalStatus = parseStatus(lastText)

        if (finalStatus.status === 'COMPLETE') {
          this.store.info('leg', `session ${legNumber} reported the mission COMPLETE`)
          leg.outcome = 'complete'
          leg.summary = firstLine(lastText)
          input.close()
          break
        }

        if (finalStatus.status === 'BLOCKED' && this.cfg.stopOnBlocked) {
          this.store.warn(
            'leg',
            `session ${legNumber} reported BLOCKED: ${finalStatus.reason ?? 'no reason given'}`,
          )
          leg.outcome = 'blocked'
          leg.reason = finalStatus.reason
          leg.summary = firstLine(lastText)
          input.close()
          break
        }
        if (finalStatus.status === 'BLOCKED') {
          this.store.warn(
            'leg',
            `session ${legNumber} reported BLOCKED: ${finalStatus.reason ?? 'no reason given'} ` +
              '— nudging on (stopOnBlocked is off)',
          )
        }

        if (this.stopRequested) {
          leg.outcome = 'stopped'
          input.close()
          break
        }

        await this.waitWhilePaused()
        if (this.stopRequested) {
          leg.outcome = 'stopped'
          input.close()
          break
        }

        const trigger = this.handoffTrigger(leg, usage)
        if (trigger) {
          handoffReason = trigger
          awaitingHandoff = true
          this.store.info(
            'handoff',
            `session ${legNumber} hitting handoff (${trigger}) at ` +
              `${usage ? `${(usage.pct * 100).toFixed(1)}%` : 'unknown'} context`,
          )
          this.notifier.emit('handoff', { leg, reason: trigger })
          input.push(
            buildHandoffPrompt({
              legNumber,
              pct: usage?.pct ?? 0,
              tokens: usage?.tokens ?? 0,
              maxTokens: usage?.maxTokens ?? 0,
              reason: trigger,
              path: this.store.handoffPath(legNumber),
            }),
          )
          continue
        }

        input.push(this.nextInstruction(legNumber))
      }
    } catch (err) {
      if (this.stopRequested) {
        leg.outcome = 'stopped'
      } else {
        const msg = (err as Error).message
        this.store.error('leg', `session ${legNumber} threw: ${msg}`)
        leg.outcome = 'error'
        leg.reason = msg
      }
      input.close()
    } finally {
      try {
        q.close()
      } catch {
        /* already closed */
      }
      this.activeQuery = null
      this.abort = null
    }

    if (leg.outcome === 'running') leg.outcome = 'stopped'
    leg.endedAt = new Date().toISOString()

    // An interrupted leg still has value if the agent wrote a handoff.
    if (!leg.handoffFile && existsSync(this.store.handoffPath(legNumber))) {
      leg.handoffFile = this.store.handoffPath(legNumber)
    }

    this.store.update((s) => {
      s.legs.push(leg)
      s.currentLeg = 0
      for (const t of s.tasks) {
        if (t.status === 'sent' && t.sentInLeg === legNumber) t.status = 'done'
      }
    })
    this.store.flush()

    this.store.info(
      'leg',
      `session ${legNumber} ended (${leg.outcome}) after ${leg.turns} turns, ` +
        `$${leg.costUsd.toFixed(3)}`,
    )
    this.notifier.emit('leg_ended', { leg })

    const continueRun =
      leg.outcome === 'handoff' ||
      (leg.outcome === 'error' && !this.stopRequested && this.shouldRetryAfterError())

    if (leg.outcome === 'error' && continueRun) {
      this.store.warn('leg', 'restarting after error — the next session gets the last handoff')
    }

    return { leg, continueRun }
  }

  // ------------------------------------------------------------------ pieces

  private buildOptions(): Options {
    const opts: Options = {
      cwd: this.cfg.cwd,
      permissionMode: this.cfg.permissionMode,
      abortController: this.abort ?? undefined,
      includePartialMessages: false,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    }

    if (this.cfg.permissionMode !== 'bypassPermissions') {
      opts.canUseTool = buildPermissionHandler(this.cfg.toolPolicy, this.store, this.cfg.cwd)
    }
    if (this.cfg.model) opts.model = this.cfg.model
    if (this.cfg.effort) opts.effort = this.cfg.effort
    if (this.cfg.allowedTools) opts.allowedTools = this.cfg.allowedTools
    if (this.cfg.disallowedTools) opts.disallowedTools = this.cfg.disallowedTools
    if (this.cfg.additionalDirectories.length > 0) {
      opts.additionalDirectories = this.cfg.additionalDirectories
    }
    if (this.cfg.disableAutoCompact) {
      opts.settings = { autoCompactEnabled: false }
    }

    return opts
  }

  /** Reads live context usage. Never fatal — an unknown reading just skips the check. */
  private async readContext(q: Query): Promise<ContextSnapshot | null> {
    let raw: SDKControlGetContextUsageResponse
    try {
      raw = await q.getContextUsage()
    } catch (err) {
      this.store.warn('context', `could not read context usage: ${(err as Error).message}`)
      return null
    }

    // `percentage` is reported 0-100 by the CLI; normalise defensively in case
    // a future version reports a fraction instead.
    const pct = raw.percentage > 1 ? raw.percentage / 100 : raw.percentage

    // How much a turn adds is a property of the workload, so measure it rather
    // than guess. The first turn of a leg carries the fixed cost of the system
    // prompt and mission, which is not growth, so deltas only count from the
    // second turn on. A drop means something compacted; that is not growth either.
    if (this.lastPct !== null) {
      const delta = pct - this.lastPct
      if (delta > 0 && (this.turnGrowth === null || delta > this.turnGrowth)) {
        this.turnGrowth = delta
      }
    }
    this.lastPct = pct

    // The reachable threshold depends on the model's output budget, on whether
    // Claude Code compacts on its own, and on how far a single turn moves —
    // none of which is known until a session is live.
    const resolved = effectiveHandoffThreshold({
      configured: this.cfg.handoffThreshold,
      maxTokens: raw.maxTokens,
      maxOutputTokens: this.maxOutputTokens,
      autoCompactThreshold: raw.autoCompactThreshold ?? null,
      autoCompactEnabled: raw.isAutoCompactEnabled,
      turnGrowth: this.turnGrowth,
    })
    this.threshold = resolved.threshold

    // Re-report if a bigger turn has since lowered the threshold further.
    if (resolved.clamped && this.threshold !== this.thresholdReported) {
      this.thresholdReported = this.threshold
      this.store.warn('context', resolved.reason ?? 'handoff threshold clamped')
    }

    const snapshot: ContextSnapshot = {
      tokens: raw.totalTokens,
      maxTokens: raw.maxTokens,
      pct,
      model: raw.model,
      maxOutputTokens: this.maxOutputTokens,
      effectiveThreshold: resolved.threshold,
      autoCompactThreshold: raw.autoCompactThreshold ?? null,
      autoCompactEnabled: raw.isAutoCompactEnabled,
      categories: raw.categories.map((c) => ({ name: c.name, tokens: c.tokens })),
      at: new Date().toISOString(),
    }

    this.store.update((s) => {
      s.context = snapshot
    })
    return snapshot
  }

  private handoffTrigger(leg: Leg, usage: ContextSnapshot | null): HandoffReason | null {
    if (this.store.state.handoffRequested) return 'operator'
    if (usage && usage.pct >= this.threshold) return 'context'
    if (this.cfg.maxTurnsPerLeg > 0 && leg.turns >= this.cfg.maxTurnsPerLeg) return 'turns'
    if (this.cfg.maxCostUsdPerLeg > 0 && leg.costUsd >= this.cfg.maxCostUsdPerLeg) return 'cost'
    return null
  }

  private nextInstruction(legNumber: number): string {
    const next = this.store.state.tasks.find((t) => t.status === 'pending')
    if (next) {
      this.store.update((s) => {
        const t = s.tasks.find((x) => x.id === next.id)
        if (t) {
          t.status = 'sent'
          t.sentInLeg = legNumber
        }
      })
      this.store.info('task', `dispatching: ${next.text.slice(0, 120)}`)
      return `# OPERATOR INSTRUCTION\n\n${next.text}`
    }
    return this.cfg.idleNudge
  }

  private persistHandoff(legNumber: number, finalText: string): string {
    const path = this.store.handoffPath(legNumber)
    if (existsSync(path)) {
      const size = readFileSync(path, 'utf8').trim().length
      if (size > 0) {
        this.store.info('handoff', `session ${legNumber} handoff written (${size} chars)`)
        return path
      }
    }
    this.store.warn(
      'handoff',
      `session ${legNumber} did not write a handoff file — salvaging its final message`,
    )
    writeFileSync(path, salvageHandoff(finalText, legNumber))
    return path
  }

  private recomputeTotalCost(current: Leg): void {
    this.store.update((s) => {
      const past = s.legs.reduce((sum, l) => sum + l.costUsd, 0)
      s.totalCostUsd = past + current.costUsd
    })
  }

  private shouldRetryAfterError(): boolean {
    // Two consecutive failed legs means the failure is structural, not transient.
    const recent = this.store.state.legs.slice(-2)
    return !(recent.length === 2 && recent.every((l) => l.outcome === 'error'))
  }

  private async waitWhilePaused(): Promise<void> {
    if (!this.pauseRequested) return
    this.store.info('control', 'holding — paused by operator')
    while (this.pauseRequested && !this.stopRequested) {
      await sleep(500)
    }
    if (!this.stopRequested) this.store.info('control', 'continuing')
  }
}

/**
 * Turns a failed result into something an operator can act on. The obvious
 * fields disagree more often than you would expect — `is_error` can be set while
 * the subtype still reads `success`, which on its own produced the memorable
 * log line "turn failed: success" — so report everything that carries a signal.
 */
export function describeFailure(result: SDKResultMessage): string {
  const parts: string[] = [`subtype=${result.subtype}`, `is_error=${result.is_error}`]

  if (result.stop_reason) parts.push(`stop_reason=${result.stop_reason}`)
  if ('api_error_status' in result && result.api_error_status) {
    parts.push(`http=${result.api_error_status}`)
  }
  if ('terminal_reason' in result && result.terminal_reason) {
    parts.push(`terminal_reason=${result.terminal_reason}`)
  }
  parts.push(`turns=${result.num_turns}`)

  const text = 'result' in result && typeof result.result === 'string' ? result.result.trim() : ''
  if (text) parts.push(`text="${truncate(text, 300)}"`)

  return parts.join(' ')
}

function truncate(text: string, n: number): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => {
      return (
        typeof b === 'object' &&
        b !== null &&
        (b as { type?: unknown }).type === 'text' &&
        typeof (b as { text?: unknown }).text === 'string'
      )
    })
    .map((b) => b.text)
    .join('\n')
}

function firstLine(text: string): string | null {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('INFINITE_STATUS'))
  if (!line) return null
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
