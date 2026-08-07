import { homedir } from 'node:os'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { Store } from './store.ts'
import type { ToolPolicy } from './types.ts'

/**
 * Commands that destroy or take over whatever path they are pointed at. For
 * these, matching the command name is not enough — the target matters, so their
 * path arguments are resolved and checked against the protected list.
 */
const DESTRUCTIVE_COMMANDS = new Set(['rm', 'rmdir', 'shred', 'mv', 'chmod', 'chown'])

/**
 * Unattended runs cannot answer permission prompts, so something has to decide.
 * `bypassPermissions` is one answer but it approves everything forever; this is
 * the narrower one — an explicit allowlist, with denials returned as normal tool
 * errors so the agent adapts instead of hanging.
 */
export function buildPermissionHandler(
  policy: ToolPolicy,
  store: Store,
  cwd: string,
): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    const decision = decide(policy, toolName, input, cwd)

    store.log(
      decision.behavior === 'allow' ? 'debug' : 'warn',
      'permission',
      `${decision.behavior === 'allow' ? 'allowed' : 'denied'} ${toolName}${
        decision.detail ? ` (${decision.detail})` : ''
      }`,
    )

    if (decision.behavior === 'allow') return { behavior: 'allow' }
    return {
      behavior: 'deny',
      message:
        `Blocked by the infinite tool policy: ${decision.detail}. ` +
        `Do not retry this call verbatim. Either use an allowed alternative, or if this ` +
        `capability is genuinely required, record it under OPEN QUESTIONS in your handoff ` +
        `so an operator can widen the policy.`,
    }
  }
}

type Decision = { behavior: 'allow' | 'deny'; detail: string }

export function decide(
  policy: ToolPolicy,
  toolName: string,
  input: Record<string, unknown>,
  cwd: string = process.cwd(),
): Decision {
  if (policy.denyTools.includes(toolName)) {
    return { behavior: 'deny', detail: `tool "${toolName}" is on the deny list` }
  }

  if (toolName === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    return decideBash(policy, cmd, cwd)
  }

  if (policy.allowTools.includes(toolName)) {
    return { behavior: 'allow', detail: 'tool allowed' }
  }

  // MCP tools are namespaced; allow a whole server with "mcp__server".
  if (toolName.startsWith('mcp__')) {
    const server = toolName.split('__').slice(0, 2).join('__')
    if (policy.allowTools.includes(server) || policy.allowTools.includes(toolName)) {
      return { behavior: 'allow', detail: 'mcp server allowed' }
    }
  }

  return policy.fallback === 'allow'
    ? { behavior: 'allow', detail: 'default allow' }
    : { behavior: 'deny', detail: `tool "${toolName}" is not on the allow list` }
}

function decideBash(policy: ToolPolicy, command: string, cwd: string): Decision {
  const normalized = command.trim()
  if (!normalized) return { behavior: 'deny', detail: 'empty command' }

  // A compound command is only as safe as its least safe segment.
  const segments = splitSegments(normalized)

  // Hard stops first. These hold even under a permissive fallback, because they
  // describe damage that no allowlist setting should be able to authorise.
  for (const segment of segments) {
    const violation = protectedPathViolation(policy, segment, cwd)
    if (violation) return { behavior: 'deny', detail: violation }

    const denied = matchingPrefix(policy.denyBash, segment, 'loose')
    if (denied) return { behavior: 'deny', detail: `matches denied command "${denied}"` }
  }

  const offender = segments.find(
    (seg) => matchingPrefix(policy.allowBash, seg, 'strict') === null,
  )
  if (offender !== undefined) {
    if (policy.fallback === 'allow') return { behavior: 'allow', detail: 'default allow' }
    return {
      behavior: 'deny',
      detail: `"${truncate(offender)}" does not match any allowed command prefix`,
    }
  }

  return { behavior: 'allow', detail: 'all segments allowed' }
}

/**
 * Returns the prefix that matches this segment, or null.
 *
 * Both modes anchor at the start of the segment, so a word appearing in an
 * argument never matches. They differ in what may follow the prefix: 'strict'
 * demands whitespace, so allowing "git status" cannot authorise "git statusfoo";
 * 'loose' accepts any non-word character, so denying "mkfs" also denies
 * "mkfs.ext4". Denials should err towards catching more.
 */
function matchingPrefix(
  prefixes: string[],
  segment: string,
  mode: 'strict' | 'loose',
): string | null {
  const s = stripEnvAssignments(segment.trim())
  if (!s) return null
  for (const raw of prefixes) {
    const prefix = raw.trim()
    if (!prefix || !s.startsWith(prefix)) continue
    const next = s[prefix.length]
    if (next === undefined || next === ' ' || next === '\t') return prefix
    if (mode === 'loose' && !/[A-Za-z0-9_]/.test(next)) return prefix
  }
  return null
}

/** `FOO=bar npm test` is an `npm test` call; the assignment must not hide it. */
function stripEnvAssignments(segment: string): string {
  let rest = segment
  for (;;) {
    const match = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/.exec(rest)
    if (!match) return rest
    rest = rest.slice(match[0].length)
  }
}

/**
 * Checks the path arguments of a destructive command against the protected
 * list. This replaces substring matching on things like "rm -rf /", which
 * denied every absolute path — `rm -rf /tmp/scratch/build` contains that
 * substring and has nothing to do with deleting the filesystem root.
 */
export function protectedPathViolation(
  policy: ToolPolicy,
  segment: string,
  cwd: string,
): string | null {
  const tokens = tokenize(stripEnvAssignments(segment.trim()))
  const command = tokens[0]
  if (!command) return null

  const name = command.split('/').pop() ?? command
  const candidates: { label: string; token: string }[] = []

  if (DESTRUCTIVE_COMMANDS.has(name)) {
    for (const token of tokens.slice(1)) {
      if (token.startsWith('-') || token.startsWith('>')) continue
      candidates.push({ label: `${name} would target`, token })
    }
  }
  for (const token of redirectTargets(segment)) {
    candidates.push({ label: 'redirection would write to', token })
  }

  for (const { label, token } of candidates) {
    const target = resolveTarget(token, cwd)
    if (target === null) continue

    const reason = protectionReason(policy, target, cwd)
    if (reason) return `${label} ${target} — ${reason}`
  }

  return null
}

function protectionReason(policy: ToolPolicy, target: string, cwd: string): string | null {
  const normalizedCwd = normalize(resolve(cwd))
  const protectedPaths = policy.protectedPaths.map((raw) =>
    normalize(resolveTarget(raw, cwd) ?? raw),
  )

  // Named protections first, so `rm -rf /` is reported as what it is rather
  // than by whichever incidental rule happens to catch it.
  for (const protectedPath of protectedPaths) {
    if (target === protectedPath) return `that path is protected`
    // Removing an ancestor removes the protected path with it.
    if (protectedPath.startsWith(withTrailingSep(target))) {
      return `that path contains the protected path ${protectedPath}`
    }
  }

  if (target === normalizedCwd) return `that is the working directory`
  if (normalizedCwd.startsWith(withTrailingSep(target))) {
    return `that path contains the working directory`
  }

  // Anything under a protected directory is protected too — otherwise naming
  // /usr/lib instead of /usr would walk straight past the list. The root is
  // excluded because every path is under it, and anything inside the project is
  // excluded because the project may well sit under a protected directory such
  // as the home directory.
  const insideProject = target.startsWith(withTrailingSep(normalizedCwd))
  if (!insideProject) {
    for (const protectedPath of protectedPaths) {
      if (protectedPath === sep) continue
      if (target.startsWith(withTrailingSep(protectedPath))) {
        return `that path is inside the protected path ${protectedPath}`
      }
    }
  }

  return null
}

/**
 * Resolves a shell token to an absolute path. A trailing glob is dropped and the
 * containing directory is checked instead, so `rm -rf /*` is judged as an
 * operation on `/`.
 */
function resolveTarget(token: string, cwd: string): string | null {
  let value = unquote(token)
  if (!value) return null

  const home = homedir()
  if (value === '~' || value === '$HOME' || value === '${HOME}') value = home
  else if (value.startsWith('~/')) value = `${home}/${value.slice(2)}`
  else if (value.startsWith('$HOME/')) value = `${home}/${value.slice(6)}`
  else if (value.startsWith('${HOME}/')) value = `${home}/${value.slice(8)}`

  const parts = value.split('/')
  const last = parts[parts.length - 1]
  if (parts.length > 1 && last !== undefined && /[*?[]/.test(last)) {
    value = parts.slice(0, -1).join('/') || '/'
  } else if (/[*?[]/.test(value)) {
    // A bare glob such as `*` means "everything here", i.e. this directory.
    value = '.'
  }

  const absolute = isAbsolute(value) ? value : resolve(cwd, value)
  return normalize(absolute)
}

function withTrailingSep(path: string): string {
  return path.endsWith(sep) ? path : path + sep
}

function unquote(token: string): string {
  if (token.length >= 2) {
    const first = token[0]
    const last = token[token.length - 1]
    if ((first === '"' || first === "'") && first === last) return token.slice(1, -1)
  }
  return token
}

function tokenize(segment: string): string[] {
  // Good enough for path inspection: quoted runs stay together, everything else
  // splits on whitespace.
  const matches = segment.match(/"[^"]*"|'[^']*'|\S+/g)
  return matches ?? []
}

/**
 * Splits a command line into the pieces that must each satisfy the allowlist.
 *
 * Operators inside quotes are not operators, so `python3 -c "a; b"` is one
 * segment rather than two — splitting blindly on `;` denied every quoted script.
 * Command substitution is split rather than ignored, so the inner command of
 * `echo $(rm -rf /etc)` is judged on its own instead of hiding behind `echo`.
 *
 * If quoting turns out to be unbalanced the shell would reject the command
 * anyway, but rather than reason about it we fall back to splitting everywhere,
 * which can only over-split.
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  const push = () => {
    const trimmed = current.trim()
    if (trimmed) segments.push(trimmed)
    current = ''
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]

    if (quote) {
      if (ch === quote) quote = null
      current += ch
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }

    if (ch === '\\') {
      current += ch + (command[i + 1] ?? '')
      i++
      continue
    }

    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      push()
      i++
      continue
    }
    if (two === '$(') {
      push()
      i++
      continue
    }
    // A subshell, substitution close, or pipeline all start a fresh command.
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '`' || ch === '(' || ch === ')') {
      push()
      continue
    }

    current += ch
  }
  push()

  if (quote !== null) {
    return command
      .split(/(?:&&|\|\||[;|`()]|\n)/g)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  return segments
}

/**
 * Output redirection writes wherever it is pointed, so its targets need the same
 * protection as a destructive command's arguments.
 */
export function redirectTargets(segment: string): string[] {
  const targets: string[] = []
  const re = />>?\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g
  for (let m = re.exec(segment); m !== null; m = re.exec(segment)) {
    targets.push(m[1])
  }
  return targets
}

function truncate(s: string, n = 60): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}
