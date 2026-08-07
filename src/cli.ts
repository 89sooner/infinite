#!/usr/bin/env node
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { loadConfig } from './config.ts'
import { Store } from './store.ts'
import { Orchestrator } from './orchestrator.ts'
import { startServer } from './server.ts'
import { handoffTemplate } from './handoff.ts'
import type { InfiniteConfig } from './types.ts'

const USAGE = `infinite — run a Claude Code agent on one mission across unlimited sessions

Usage:
  infinite run [options]      Start (or continue) the run
  infinite status             Print the current run state
  infinite init               Write a starter config and MISSION.md
  infinite handoff <n>        Print the handoff from session <n>

Options:
  --cwd <dir>            Working directory for the agent      (default: .)
  --config <file>        Config file        (default: <cwd>/infinite.config.json)
  --mission <file>       Mission file                (default: <cwd>/MISSION.md)
  --threshold <0-1>      Context fraction that triggers a handoff   (default: 0.8)
  --model <name>         Model to run
  --max-legs <n>         Stop after n sessions; 0 is unlimited        (default: 0)
  --max-cost <usd>       Stop the run after this much spend           (default: 0)
  --server               Serve the dashboard
  --port <n>             Dashboard port                            (default: 4319)
  --host <addr>          Dashboard bind address              (default: 127.0.0.1)
  --bypass-permissions   Approve every tool call instead of using the tool policy
  --no-auto-compact      Turn off Claude Code's own compaction
  --quiet                Do not mirror the event log to stdout
  -h, --help             This message

Environment:
  INFINITE_THRESHOLD, INFINITE_PORT, INFINITE_TOKEN, INFINITE_MODEL
`

type Flags = Record<string, string | boolean>

function parseArgs(argv: string[]): { command: string; flags: Flags; positional: string[] } {
  const flags: Flags = {}
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      if (arg === '-h') flags.help = true
      else positional.push(arg)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      flags[key] = true
    }
  }
  const command = positional.shift() ?? 'run'
  return { command, flags, positional }
}

function overridesFrom(flags: Flags): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  const server: Record<string, unknown> = {}

  if (typeof flags.mission === 'string') o.missionFile = flags.mission
  if (typeof flags.threshold === 'string') o.handoffThreshold = Number(flags.threshold)
  if (typeof flags.model === 'string') o.model = flags.model
  if (typeof flags['max-legs'] === 'string') o.maxLegs = Number(flags['max-legs'])
  if (typeof flags['max-cost'] === 'string') o.maxCostUsdTotal = Number(flags['max-cost'])
  if (flags['bypass-permissions'] === true) o.permissionMode = 'bypassPermissions'
  if (flags['no-auto-compact'] === true) o.disableAutoCompact = true

  if (flags.server === true) server.enabled = true
  if (typeof flags.port === 'string') {
    server.port = Number(flags.port)
    server.enabled = true
  }
  if (typeof flags.host === 'string') {
    server.host = flags.host
    server.enabled = true
  }
  if (Object.keys(server).length > 0) o.server = server

  return o
}

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv.slice(2))

  if (flags.help === true || command === 'help') {
    process.stdout.write(USAGE)
    return
  }

  const cwd = typeof flags.cwd === 'string' ? resolve(flags.cwd) : process.cwd()

  if (command === 'init') {
    initProject(cwd)
    return
  }

  const cfg = loadConfig({
    cwd,
    configFile: typeof flags.config === 'string' ? flags.config : undefined,
    overrides: overridesFrom(flags),
  })

  if (command === 'status') {
    const store = new Store(cfg, { quiet: true })
    printStatus(cfg, store)
    return
  }

  if (command === 'handoff') {
    const store = new Store(cfg, { quiet: true })
    const n = Number(positional[0])
    if (!Number.isFinite(n)) throw new Error('usage: infinite handoff <session-number>')
    const body = store.readHandoff(n)
    if (body === null) throw new Error(`no handoff stored for session ${n}`)
    process.stdout.write(`${body}\n`)
    return
  }

  if (command !== 'run') throw new Error(`unknown command "${command}"\n\n${USAGE}`)

  await runCommand(cfg, flags.quiet === true)
}

async function runCommand(cfg: InfiniteConfig, quiet: boolean): Promise<void> {
  const store = new Store(cfg, { quiet })
  const orch = new Orchestrator(cfg, store)
  const server = cfg.server.enabled ? startServer(cfg, store, orch) : null

  let stopping = false
  const shutdown = (signal: string) => {
    if (stopping) {
      process.stderr.write('\nforced exit\n')
      process.exit(130)
    }
    stopping = true
    process.stderr.write(`\n${signal} — stopping after the current turn (again to force)\n`)
    orch.stop()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  try {
    await orch.run()
  } finally {
    store.flush()
    server?.close()
  }

  const status = store.state.status
  process.exitCode = status === 'error' ? 1 : 0
}

function printStatus(cfg: InfiniteConfig, store: Store): void {
  const s = store.state
  const ctx = s.context
  const out: string[] = [
    `status        ${s.status}`,
    `mission       ${s.missionPath}`,
    `sessions      ${s.legs.length} completed${s.currentLeg ? `, ${s.currentLeg} active` : ''}`,
    `turns         ${s.totalTurns}`,
    `spend         $${s.totalCostUsd.toFixed(2)}`,
    `threshold     ${(cfg.handoffThreshold * 100).toFixed(0)}%`,
    ctx
      ? `context       ${(ctx.pct * 100).toFixed(1)}% (${ctx.tokens.toLocaleString()} / ${ctx.maxTokens.toLocaleString()}) on ${ctx.model}`
      : 'context       no reading yet',
  ]
  if (s.lastError) out.push(`last error    ${s.lastError}`)

  if (s.legs.length > 0) {
    out.push('', 'sessions:')
    for (const leg of s.legs.slice(-12)) {
      out.push(
        `  ${String(leg.n).padStart(3)}  ${leg.outcome.padEnd(9)} ` +
          `${String(leg.turns).padStart(3)} turns  ` +
          `${(leg.contextPct * 100).toFixed(0).padStart(3)}%  ` +
          `$${leg.costUsd.toFixed(2).padStart(7)}  ${leg.summary ?? ''}`,
      )
    }
  }
  process.stdout.write(`${out.join('\n')}\n`)
}

function initProject(cwd: string): void {
  mkdirSync(cwd, { recursive: true })

  const configPath = join(cwd, 'infinite.config.json')
  if (existsSync(configPath)) {
    process.stdout.write(`kept existing ${configPath}\n`)
  } else {
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          missionFile: 'MISSION.md',
          handoffThreshold: 0.8,
          maxLegs: 0,
          maxCostUsdTotal: 0,
          legCooldownSec: 5,
          model: null,
          permissionMode: 'default',
          disableAutoCompact: false,
          stopOnBlocked: false,
          server: { enabled: true, host: '127.0.0.1', port: 4319, token: null },
        },
        null,
        2,
      )}\n`,
    )
    process.stdout.write(`wrote ${configPath}\n`)
  }

  const missionPath = join(cwd, 'MISSION.md')
  if (existsSync(missionPath)) {
    process.stdout.write(`kept existing ${missionPath}\n`)
  } else {
    writeFileSync(missionPath, MISSION_STARTER)
    process.stdout.write(`wrote ${missionPath}\n`)
  }

  const templatePath = join(cwd, 'HANDOFF.template.md')
  if (!existsSync(templatePath)) {
    writeFileSync(templatePath, handoffTemplate())
    process.stdout.write(`wrote ${templatePath}\n`)
  }

  process.stdout.write('\nEdit MISSION.md, then run: infinite run --server\n')
}

const MISSION_STARTER = `# Mission

<!-- This text is injected verbatim into every session, forever. It is the one
     thing that never gets summarized, so keep it stable and keep it tight. -->

## Goal

Describe the outcome, not the steps. What is true when this is finished?

## Definition of done

- [ ] A concrete, checkable condition
- [ ] Another one

## Constraints

- Which files, directories or systems are off limits
- Which commands must never run
- Anything the agent must ask about rather than decide

## Notes

Useful starting context: where the code lives, how to run the tests, who owns what.
`

main().catch((err: unknown) => {
  process.stderr.write(`infinite: ${(err as Error).message}\n`)
  process.exit(1)
})
