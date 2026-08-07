import type { Leg } from './types.ts'

/**
 * The handoff document is the only thing that survives a session boundary, so
 * its structure is fixed and the instructions are deliberately blunt. Vague
 * handoffs are the single biggest failure mode of a relayed agent: the next
 * session re-derives what the last one already knew, or worse, retries an
 * approach that was already proven not to work.
 */
export const HANDOFF_SECTIONS = [
  'STATE',
  'NEXT STEPS',
  'FACTS AND DECISIONS',
  'DEAD ENDS',
  'OPEN QUESTIONS',
  'FILES',
] as const

export function handoffTemplate(): string {
  return `# Handoff

## STATE
<!-- What is actually true right now. Distinguish VERIFIED (you ran it and saw
     the result) from ASSUMED (you believe it but did not check). -->

## NEXT STEPS
<!-- Ordered, concrete, executable. "Run \`npm test -- auth.spec.ts\` and fix the
     two failing assertions in src/auth/token.ts" — not "continue the auth work". -->

## FACTS AND DECISIONS
<!-- Exact file paths, commands that work, versions, API shapes, config keys,
     and decisions already made with the reason. Anything the next session would
     otherwise have to rediscover by reading files. -->

## DEAD ENDS
<!-- Approaches already tried that did not work, and why. This section prevents
     the next session from burning its whole context repeating your mistakes.
     If you tried nothing that failed, write "none". -->

## OPEN QUESTIONS
<!-- Unknowns blocking progress, and what would resolve each. Write "none" if empty. -->

## FILES
<!-- Files created or modified so far, one per line, with a few words on each. -->
`
}

export type LegStartInput = {
  legNumber: number
  mission: string
  previousHandoff: string | null
  progressLog: Leg[]
  tasks: string[]
  thresholdPct: number
}

export function buildLegPrompt(input: LegStartInput): string {
  const { legNumber, mission, previousHandoff, progressLog, tasks, thresholdPct } = input
  const parts: string[] = []

  parts.push(
    `# INFINITE — session ${legNumber}`,
    '',
    'You are one session in a relay working on a single long-running mission.',
    'When your context window fills up you will be asked to write a handoff document,',
    'this session will end, and a fresh session will pick the mission up from that',
    'document alone. Work accordingly: keep durable knowledge in files, not in your head.',
    '',
  )

  parts.push('## MISSION', '', mission.trim(), '')

  if (progressLog.length > 0) {
    parts.push('## PROGRESS SO FAR (one line per completed session)', '')
    for (const leg of progressLog) {
      const note = leg.summary ?? `(no summary — ended ${leg.outcome})`
      parts.push(`- Session ${leg.n}: ${note}`)
    }
    parts.push('')
  }

  if (previousHandoff) {
    parts.push(
      `## HANDOFF FROM SESSION ${legNumber - 1}`,
      '',
      'This is everything the previous session chose to carry forward. Trust it as a',
      'starting point, but re-verify anything it marked ASSUMED before you build on it.',
      '',
      previousHandoff.trim(),
      '',
    )
  } else {
    parts.push(
      '## STARTING FRESH',
      '',
      'This is the first session. No handoff exists yet.',
      '',
    )
  }

  if (tasks.length > 0) {
    parts.push('## OPERATOR INSTRUCTIONS (added since the last session)', '')
    for (const t of tasks) parts.push(`- ${t}`)
    parts.push('')
  }

  parts.push(
    '## PROTOCOL',
    '',
    `- Your context is monitored. At ${Math.round(thresholdPct * 100)}% full you will get a`,
    '  HANDOFF REQUESTED message. Everything up to that point must be recoverable from',
    '  the handoff you then write, so record findings in files as you go.',
    '- End EVERY response with a status line, exactly one of:',
    '    INFINITE_STATUS: CONTINUE',
    '    INFINITE_STATUS: COMPLETE',
    '    INFINITE_STATUS: BLOCKED: <one-line reason>',
    '  Use COMPLETE only when the whole mission is done, not the current step.',
    '  Use BLOCKED when you cannot make progress without a human decision.',
    '- Prefer many small verified steps over one large unverified one.',
    '- If you are unsure whether something works, run it and find out.',
    '',
    'Begin.',
  )

  return parts.join('\n')
}

export type HandoffRequestInput = {
  legNumber: number
  pct: number
  tokens: number
  maxTokens: number
  reason: 'context' | 'turns' | 'cost' | 'operator'
  path: string
}

export function buildHandoffPrompt(input: HandoffRequestInput): string {
  const { legNumber, pct, tokens, maxTokens, reason, path } = input

  const why =
    reason === 'context'
      ? `Your context window is ${Math.round(pct * 100)}% full (${tokens.toLocaleString()} of ${maxTokens.toLocaleString()} tokens).`
      : reason === 'turns'
        ? 'This session has reached its configured turn limit.'
        : reason === 'cost'
          ? 'This session has reached its configured spend limit.'
          : 'An operator requested a handoff.'

  return [
    '# HANDOFF REQUESTED',
    '',
    why,
    'This session ends after your next response. A fresh session with an empty',
    'context will continue the mission using ONLY the document you are about to',
    'write. Nothing else carries over — not this conversation, not what you read,',
    'not what you figured out. If it is not in the document, it is lost.',
    '',
    `Write the handoff now with the Write tool to exactly this path:`,
    '',
    `    ${path}`,
    '',
    'Use exactly these six headings, in this order:',
    '',
    HANDOFF_SECTIONS.map((s) => `## ${s}`).join('\n'),
    '',
    '## What each section is for',
    '',
    '- STATE — what is true right now. Mark each claim VERIFIED (you ran it and saw',
    '  the result) or ASSUMED (you believe it but did not check).',
    '- NEXT STEPS — ordered and executable. Name files, commands, and functions.',
    '  "Run `npm test -- auth.spec.ts` and fix the failing assertion in',
    '  src/auth/token.ts:44" is useful. "Continue the auth work" is not.',
    '- FACTS AND DECISIONS — exact paths, working commands, versions, API shapes,',
    '  config keys, and any decision you made plus the reason for it. Everything the',
    '  next session would otherwise rediscover by re-reading the codebase.',
    '- DEAD ENDS — what you tried that did not work, and why. Without this the next',
    '  session will repeat your failures. Write "none" if there were none.',
    '- OPEN QUESTIONS — what is unknown and what would resolve it. "none" if empty.',
    '- FILES — files you created or modified, one per line, a few words each.',
    '',
    '## Rules',
    '',
    '- Write for a competent stranger who has never seen this mission.',
    '- Be specific over brief, but do not pad. Aim for signal.',
    '- Never write "as discussed", "the above", or "we decided earlier" — the next',
    '  session has no earlier.',
    '- Do not start new work. Do not fix one more thing. Write the document.',
    '',
    'After writing the file, reply with a single line and nothing else:',
    '',
    '    INFINITE_SUMMARY: <one sentence describing what this session accomplished>',
  ].join('\n')
}

export type ParsedStatus = {
  status: 'CONTINUE' | 'COMPLETE' | 'BLOCKED' | null
  reason: string | null
}

/** Reads the trailing status line the protocol asks for. Last match wins. */
export function parseStatus(text: string): ParsedStatus {
  const re = /INFINITE_STATUS:\s*(CONTINUE|COMPLETE|BLOCKED)\s*(?::\s*([^\n]*))?/gi
  let last: RegExpExecArray | null = null
  for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m
  if (!last) return { status: null, reason: null }
  const status = last[1].toUpperCase() as ParsedStatus['status']
  const reason = last[2]?.trim() || null
  return { status, reason }
}

export function parseSummary(text: string): string | null {
  const m = /INFINITE_SUMMARY:\s*([^\n]+)/i.exec(text)
  return m ? m[1].trim() : null
}

/**
 * Fallback when the agent did not write the handoff file. Better than losing the
 * leg entirely — the final message usually still contains the substance.
 */
export function salvageHandoff(finalText: string, legNumber: number): string {
  return [
    '# Handoff (salvaged)',
    '',
    `Session ${legNumber} did not write a handoff file. The text below is its final`,
    'response, recovered verbatim. Treat every claim in it as ASSUMED, not verified.',
    '',
    '---',
    '',
    finalText.trim() || '(the session produced no final text)',
  ].join('\n')
}
