import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import type { Store } from './store.ts'
import type { ToolPolicy } from './types.ts'

/**
 * Unattended runs cannot answer permission prompts, so something has to decide.
 * `bypassPermissions` is one answer but it approves everything forever; this is
 * the narrower one — an explicit allowlist, with denials returned as normal tool
 * errors so the agent adapts instead of hanging.
 */
export function buildPermissionHandler(policy: ToolPolicy, store: Store): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    const decision = decide(policy, toolName, input)

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
): Decision {
  if (policy.denyTools.includes(toolName)) {
    return { behavior: 'deny', detail: `tool "${toolName}" is on the deny list` }
  }

  if (toolName === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    return decideBash(policy, cmd)
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

function decideBash(policy: ToolPolicy, command: string): Decision {
  const normalized = command.trim()
  if (!normalized) return { behavior: 'deny', detail: 'empty command' }

  const lowered = normalized.toLowerCase()
  for (const bad of policy.denyBash) {
    if (lowered.includes(bad.toLowerCase())) {
      return { behavior: 'deny', detail: `matches denied pattern "${bad}"` }
    }
  }

  // A compound command is only as safe as its least safe segment.
  const segments = splitSegments(normalized)
  const offender = segments.find((seg) => !segmentAllowed(policy, seg))
  if (offender !== undefined) {
    if (policy.fallback === 'allow') return { behavior: 'allow', detail: 'default allow' }
    return {
      behavior: 'deny',
      detail: `"${truncate(offender)}" does not match any allowed command prefix`,
    }
  }

  return { behavior: 'allow', detail: 'all segments allowed' }
}

function segmentAllowed(policy: ToolPolicy, segment: string): boolean {
  const s = segment.trim()
  if (!s) return true
  return policy.allowBash.some((prefix) => {
    const p = prefix.trim()
    if (!s.startsWith(p)) return false
    // "git status" must not match "git statusfoo"; require a word boundary.
    const next = s[p.length]
    return next === undefined || next === ' ' || next === '\t'
  })
}

function splitSegments(command: string): string[] {
  // Deliberately conservative: any shell operator starts a new segment that must
  // independently match the allowlist. Quoting is not parsed, which can only
  // ever split more than necessary, never less.
  return command
    .split(/(?:&&|\|\||[;|]|\n)/g)
    .map((s) => s.trim())
    .filter(Boolean)
}

function truncate(s: string, n = 60): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}
