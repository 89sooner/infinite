import { readFileSync, existsSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'
import type { InfiniteConfig, ToolPolicy } from './types.ts'
import { ALL_EVENTS } from './notify/types.ts'
import type { NotifyEventName } from './notify/types.ts'

/**
 * A useful default: the moments an operator actually wants pushed to a phone.
 * `leg_ended` is deliberately absent — `handoff` plus `leg_started` already
 * cover the same transition without doubling the message count.
 */
const DEFAULT_NOTIFY_EVENTS: NotifyEventName[] = [
  'handoff',
  'leg_started',
  'run_complete',
  'run_blocked',
  'run_stopped',
  'run_error',
]

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
    // Inspection
    'ls',
    'cat',
    'head',
    'tail',
    'wc',
    'find',
    'grep',
    'rg',
    'egrep',
    'fgrep',
    'file',
    'stat',
    'du',
    'df',
    'diff',
    'pwd',
    'which',
    'type',
    'realpath',
    'readlink',
    'basename',
    'dirname',
    'date',
    'env',
    'printenv',
    // Text processing. Their absence was the single biggest source of friction:
    // an agent that cannot run sed or awk burns turns rediscovering that.
    'sed',
    'awk',
    'cut',
    'tr',
    'sort',
    'uniq',
    'comm',
    'paste',
    'tee',
    'xargs',
    'jq',
    'echo',
    'printf',
    // Navigation. Without this, `cd build && make` fails on the first segment.
    'cd',
    // Files. Destructive ones are additionally checked against protectedPaths.
    'mkdir',
    'touch',
    'cp',
    'mv',
    'rm',
    'rmdir',
    'ln',
    'chmod',
    'mktemp',
    'tar',
    'gzip',
    'gunzip',
    'unzip',
    // Git. Read and local-history commands only — `git push` is deliberately
    // absent so an unattended agent cannot publish without an explicit opt-in.
    'git status',
    'git diff',
    'git log',
    'git show',
    'git add',
    'git commit',
    'git branch',
    'git checkout',
    'git switch',
    'git restore',
    'git stash',
    'git rev-parse',
    'git ls-files',
    'git blame',
    'git describe',
    'git config',
    'git remote',
    'git tag',
    'git fetch',
    'git merge',
    'git rebase',
    // Toolchains
    'npm',
    'npx',
    'pnpm',
    'yarn',
    'node',
    'deno',
    'bun',
    'tsc',
    'eslint',
    'prettier',
    'jest',
    'vitest',
    'python',
    'python3',
    'pip',
    'pip3',
    'pytest',
    'ruff',
    'black',
    'mypy',
    'make',
    'cargo',
    'rustc',
    'go',
    'gofmt',
  ],
  // Prefixes, matched per command segment at a word boundary — not substrings of
  // the whole command line, which used to make prose like `echo "shutdown at 5"`
  // look like a shutdown. Destructive targets are handled by protectedPaths.
  denyBash: [
    'mkfs',
    'shutdown',
    'reboot',
    'halt',
    'poweroff',
    'dd',
    'sudo',
    'su',
    'chown',
    'git push --force',
    'git push -f',
  ],
  // Paths a destructive command may never target, directly or by containing
  // them. The working directory and everything above it are protected too, so
  // this list only needs to name what lies outside the project.
  protectedPaths: [
    '/',
    '/bin',
    '/boot',
    '/dev',
    '/etc',
    '/home',
    '/lib',
    '/lib64',
    '/opt',
    '/proc',
    '/root',
    '/run',
    '/sbin',
    '/srv',
    '/sys',
    '/usr',
    '/var',
    '~',
    '~/.ssh',
    '~/.aws',
    '~/.config',
    '~/.claude',
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

    // On by default. Claude Code's own compaction fires mid-turn, so on a real
    // long run it beats the handoff threshold — which is checked between turns —
    // and the run degrades into exactly the repeated in-session summarisation
    // this tool exists to replace. infinite manages the context; leaving a
    // second manager running underneath it means neither is in charge.
    disableAutoCompact: true,

    idleNudge: DEFAULT_IDLE_NUDGE,
    stopOnBlocked: false,

    server: {
      enabled: false,
      host: '127.0.0.1',
      port: 4319,
      token: process.env.INFINITE_TOKEN ?? null,
    },

    notifications: {
      enabled: false,
      events: DEFAULT_NOTIFY_EVENTS,
      minSeverity: 'info',
      dashboardUrl: null,
      channels: [],
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

/**
 * Expands `${VAR}` from the environment throughout the config file so secrets —
 * messenger tokens above all — stay out of a file that gets committed. A missing
 * variable is an error rather than an empty string: silently sending an
 * unauthenticated request is worse than refusing to start.
 *
 * `{{field}}` placeholders used by notification templates are a different syntax
 * and pass through untouched.
 */
function expandEnv(value: unknown, file: string, path = ''): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, name: string) => {
      const found = process.env[name]
      if (found === undefined) {
        throw new Error(
          `${file} refers to \${${name}}${path ? ` at ${path}` : ''} but that ` +
            `environment variable is not set`,
        )
      }
      return found
    })
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => expandEnv(item, file, `${path}[${i}]`))
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = expandEnv(v, file, path ? `${path}.${k}` : k)
    }
    return out
  }
  return value
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
    cfg = merge(cfg, expandEnv(parsed, file) as Record<string, unknown>)
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
  if (!Array.isArray(cfg.toolPolicy.protectedPaths)) {
    throw new Error('toolPolicy.protectedPaths must be an array of paths')
  }
  validateNotifications(cfg)
}

function validateNotifications(cfg: InfiniteConfig): void {
  const n = cfg.notifications
  const seen = new Set<string>()

  for (const event of n.events) {
    if (!ALL_EVENTS.includes(event)) {
      throw new Error(
        `notifications.events contains unknown event "${event}". Valid: ${ALL_EVENTS.join(', ')}`,
      )
    }
  }

  for (const channel of n.channels) {
    if (!channel.name) throw new Error('every notification channel needs a "name"')
    if (seen.has(channel.name)) {
      throw new Error(`duplicate notification channel name "${channel.name}"`)
    }
    seen.add(channel.name)

    for (const event of channel.events ?? []) {
      if (!ALL_EVENTS.includes(event)) {
        throw new Error(
          `channel "${channel.name}" subscribes to unknown event "${event}". ` +
            `Valid: ${ALL_EVENTS.join(', ')}`,
        )
      }
    }

    if (channel.kind === 'webhook' || channel.kind === 'knox') {
      if (!channel.url) {
        throw new Error(`channel "${channel.name}" (${channel.kind}) needs a "url"`)
      }
      try {
        new URL(channel.url)
      } catch {
        throw new Error(`channel "${channel.name}" has an invalid url: ${channel.url}`)
      }
    } else if (channel.kind === 'command') {
      if (!channel.command) throw new Error(`channel "${channel.name}" (command) needs a "command"`)
    } else {
      const kind = (channel as { kind: string }).kind
      throw new Error(
        `channel "${channel.name}" has unknown kind "${kind}". Valid: webhook, knox, command`,
      )
    }
  }

  if (n.enabled && n.channels.length === 0) {
    throw new Error('notifications.enabled is true but notifications.channels is empty')
  }
}

export { DEFAULT_TOOL_POLICY }
