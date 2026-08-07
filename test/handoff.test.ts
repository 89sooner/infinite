import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHandoffPrompt,
  buildLegPrompt,
  parseStatus,
  parseSummary,
  salvageHandoff,
  HANDOFF_SECTIONS,
} from '../src/handoff.ts'
import type { Leg } from '../src/types.ts'

function leg(n: number, summary: string | null): Leg {
  return {
    n,
    sessionId: null,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T01:00:00Z',
    turns: 3,
    costUsd: 1,
    contextTokens: 100,
    contextMaxTokens: 200,
    contextPct: 0.5,
    outcome: 'handoff',
    summary,
    handoffFile: null,
    reason: null,
  }
}

describe('status parsing', () => {
  test('reads each status keyword', () => {
    assert.equal(parseStatus('work done\nINFINITE_STATUS: CONTINUE').status, 'CONTINUE')
    assert.equal(parseStatus('INFINITE_STATUS: COMPLETE').status, 'COMPLETE')
  })

  test('captures the reason on BLOCKED', () => {
    const parsed = parseStatus('INFINITE_STATUS: BLOCKED: needs a production credential')
    assert.equal(parsed.status, 'BLOCKED')
    assert.equal(parsed.reason, 'needs a production credential')
  })

  test('the last status line wins', () => {
    // A session that quotes the protocol before reporting must not be misread.
    const text = 'I will report INFINITE_STATUS: COMPLETE when done.\n\nINFINITE_STATUS: CONTINUE'
    assert.equal(parseStatus(text).status, 'CONTINUE')
  })

  test('returns null when no status line is present', () => {
    assert.equal(parseStatus('just some prose').status, null)
  })

  test('is case insensitive on the keyword', () => {
    assert.equal(parseStatus('infinite_status: complete').status, 'COMPLETE')
  })
})

describe('summary parsing', () => {
  test('extracts the summary line', () => {
    assert.equal(parseSummary('INFINITE_SUMMARY: added the parser'), 'added the parser')
  })

  test('returns null when absent', () => {
    assert.equal(parseSummary('no summary here'), null)
  })
})

describe('leg prompt', () => {
  const mission = '# Mission\n\nShip the thing.\n\n## Constraints\n- Never touch prod'

  test('carries the mission verbatim', () => {
    const prompt = buildLegPrompt({
      legNumber: 1,
      mission,
      previousHandoff: null,
      progressLog: [],
      tasks: [],
      thresholdPct: 0.8,
    })
    // The whole point of the design: the mission is never summarized.
    assert.ok(prompt.includes('Ship the thing.'))
    assert.ok(prompt.includes('- Never touch prod'))
    assert.ok(prompt.includes('STARTING FRESH'))
  })

  test('includes the previous handoff and the progress log', () => {
    const prompt = buildLegPrompt({
      legNumber: 3,
      mission,
      previousHandoff: '## STATE\n- one file written',
      progressLog: [leg(1, 'did the first bit'), leg(2, 'did the second bit')],
      tasks: ['also update the changelog'],
      thresholdPct: 0.8,
    })
    assert.ok(prompt.includes('HANDOFF FROM SESSION 2'))
    assert.ok(prompt.includes('- one file written'))
    assert.ok(prompt.includes('Session 1: did the first bit'))
    assert.ok(prompt.includes('Session 2: did the second bit'))
    assert.ok(prompt.includes('also update the changelog'))
  })

  test('describes a leg with no summary rather than dropping it', () => {
    const prompt = buildLegPrompt({
      legNumber: 2,
      mission,
      previousHandoff: null,
      progressLog: [leg(1, null)],
      tasks: [],
      thresholdPct: 0.8,
    })
    assert.ok(prompt.includes('Session 1: (no summary'))
  })

  test('states the protocol and the configured threshold', () => {
    const prompt = buildLegPrompt({
      legNumber: 1,
      mission,
      previousHandoff: null,
      progressLog: [],
      tasks: [],
      thresholdPct: 0.75,
    })
    assert.ok(prompt.includes('INFINITE_STATUS: CONTINUE'))
    assert.ok(prompt.includes('INFINITE_STATUS: COMPLETE'))
    assert.ok(prompt.includes('75%'))
  })
})

describe('handoff prompt', () => {
  test('names every required section and the exact output path', () => {
    const prompt = buildHandoffPrompt({
      legNumber: 4,
      pct: 0.81,
      tokens: 162_000,
      maxTokens: 200_000,
      reason: 'context',
      path: '/srv/app/.infinite/handoffs/leg-004.md',
    })
    for (const section of HANDOFF_SECTIONS) {
      assert.ok(prompt.includes(`## ${section}`), `missing section ${section}`)
    }
    assert.ok(prompt.includes('/srv/app/.infinite/handoffs/leg-004.md'))
    assert.ok(prompt.includes('81%'))
    assert.ok(prompt.includes('162,000'))
    assert.ok(prompt.includes('INFINITE_SUMMARY:'))
  })

  test('explains each non-context trigger in its own words', () => {
    const base = { legNumber: 1, pct: 0.4, tokens: 1, maxTokens: 2, path: '/tmp/h.md' }
    assert.match(buildHandoffPrompt({ ...base, reason: 'turns' }), /turn limit/)
    assert.match(buildHandoffPrompt({ ...base, reason: 'cost' }), /spend limit/)
    assert.match(buildHandoffPrompt({ ...base, reason: 'operator' }), /operator requested/)
  })
})

describe('salvage', () => {
  test('keeps the final text and marks it unverified', () => {
    const out = salvageHandoff('I created src/a.ts and it compiles.', 7)
    assert.ok(out.includes('I created src/a.ts and it compiles.'))
    assert.ok(out.includes('ASSUMED'))
    assert.ok(out.includes('Session 7'))
  })

  test('handles an empty final message', () => {
    assert.ok(salvageHandoff('   ', 2).includes('no final text'))
  })
})
