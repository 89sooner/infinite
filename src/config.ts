import { readFileSync, existsSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import type { InfiniteConfig, ToolPolicy } from './types.ts'

const DEFAULT_TOOL_POLICY: ToolPolicy = {
  allowTools: [
    'Read',
    'Glob',
    'Grep',
    'NotebookRead',
    'TodoWrite',
    'Task',
    'WebFetch',
    'WebSearch',
    'Edit',
    'Write',
    'NotebookEdit',
  ],
  denyTools: [],
  allowBash: [
    'ls',
    'cat',
    'head',
    'tail',
    'wc',
    'find',
    'grep',
    'rg',
    'echo',
    'pwd',
    'which',
    'file',
    'stat',
    'diff',
    'sort',
    'uniq',
    'date',
    'git status',
    'git diff',
    'git log',
    'git show',
    'git add',
    'git commit',
    'git branch',
    'git checkout',
    'git switch',
    'git stash',
    'git rev-parse',
    'npm test',
    'npm run',
    'npm ci',
    'npm install',
    'npx',
    'node',
    'python',
    'python3',
    'pytest',
    'make',
    'cargo',
    'go test',
    'go build',
    'mkdir',
    'touch',
  ],
  denyBash: [
    'rm -rf /',
    'mkfs',
    'shutdown',
    'reboot',
    ':(){',
    'dd if=',
    'curl | sh',
    'curl|sh',
    'wget | sh',
    'chmod 777 /',
    'git push --force origin main',
    'git push -f origin main',
  ],
  fallback: 'deny',
}

export const DEFAULT_IDLE_NUDGE =
  'No new instruction. Continue the mission from where the handoff left off. ' +
  'Pick the highest-value next step, do it, and report what changed.'

function defaults(cwd: string): InfiniteConfig {
  return {
    cwd,
    missionFile: resolve(cwd, 'MISSION.md'),
    stateDir: resolve(cwd, '.infinite'),

    handoffThreshold: 0.8,
    maxLegs: 0,
    maxTurnsPerLeg: 0,
    maxCostUsdPerLeg: 0,
    maxCostUsdTotal: 0,
    legCooldownSec: 5,

    model: null,
    effort: null,
    permissionMode: 'default',
    toolPolicy: DEFAULT_TOOL_POLICY,
    allowedTools: null,
    disallowedTools: null,
    additionalDirectories: [],

    disableAutoCompact: false,

    idleNudge: DEFAULT_IDLE_NUDGE,
    stopOnBlocked: false,

    server: {
      enabled: false,
      host: '127.0.0.1',
      port: 4319,
      token: process.env.INFINITE_TOKEN ?? null,
    },
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Shallow merge, one level deep for the nested `server` and `toolPolicy` objects. */
function merge(base: InfiniteConfig, patch: Record<string, unknown>): InfiniteConfig {
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue
    if (isRecord(v) && isRecord(out[k])) {
      out[k] = { ...(out[k] as Record<string, unknown>), ...v }
    } else {
      out[k] = v
    }
  }
  return out as unknown as InfiniteConfig
}

function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p)
}

export type LoadOptions = {
  cwd?: string
  configFile?: string
  overrides?: Record<string, unknown>
}

export function loadConfig(opts: LoadOptions = {}): InfiniteConfig {
  const cwd = resolve(opts.cwd ?? process.cwd())
  let cfg = defaults(cwd)

  const file = opts.configFile
    ? abs(cwd, opts.configFile)
    : resolve(cwd, 'infinite.config.json')

  if (existsSync(file)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
      throw new Error(`Could not parse ${file}: ${(err as Error).message}`)
    }
    if (!isRecord(parsed)) throw new Error(`${file} must contain a JSON object`)
    cfg = merge(cfg, parsed)
  }

  if (opts.overrides) cfg = merge(cfg, opts.overrides)

  // Env overrides win over the file so a systemd unit can retune without edits.
  if (process.env.INFINITE_THRESHOLD) {
    cfg.handoffThreshold = Number(process.env.INFINITE_THRESHOLD)
  }
  if (process.env.INFINITE_PORT) cfg.server.port = Number(process.env.INFINITE_PORT)
  if (process.env.INFINITE_TOKEN) cfg.server.token = process.env.INFINITE_TOKEN
  if (process.env.INFINITE_MODEL) cfg.model = process.env.INFINITE_MODEL

  cfg.cwd = abs(cwd, cfg.cwd)
  cfg.missionFile = abs(cfg.cwd, cfg.missionFile)
  cfg.stateDir = abs(cfg.cwd, cfg.stateDir)
  cfg.additionalDirectories = cfg.additionalDirectories.map((d) => abs(cfg.cwd, d))

  validate(cfg)
  return cfg
}

function validate(cfg: InfiniteConfig): void {
  if (!(cfg.handoffThreshold > 0 && cfg.handoffThreshold < 1)) {
    throw new Error(
      `handoffThreshold must be between 0 and 1 (exclusive), got ${cfg.handoffThreshold}`,
    )
  }
  if (cfg.handoffThreshold > 0.92) {
    throw new Error(
      `handoffThreshold ${cfg.handoffThreshold} leaves no room to write the handoff. Use 0.9 or less.`,
    )
  }
  if (!existsSync(cfg.cwd)) throw new Error(`cwd does not exist: ${cfg.cwd}`)
  if (cfg.toolPolicy.fallback !== 'allow' && cfg.toolPolicy.fallback !== 'deny') {
    throw new Error(`toolPolicy.fallback must be "allow" or "deny"`)
  }
}

export { DEFAULT_TOOL_POLICY }
