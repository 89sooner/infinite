import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveHandoffThreshold,
  pickMaxOutputTokens,
  ASSUMED_TURN_GROWTH,
  HANDOFF_MARGIN,
  MIN_THRESHOLD,
} from '../src/threshold.ts'

/** Treated as a run that has measured a negligible per-turn jump. */
const TINY_GROWTH = 0.01

// The session that exposed this: a 200k window with a 32k output reserve and
// Claude Code compacting at 167k. A configured 80% never fired, because both
// limits sit below it.
const HAIKU = {
  maxTokens: 200_000,
  maxOutputTokens: 32_000,
  autoCompactThreshold: 167_000,
}

// A million-token window has room to spare, so nothing should be clamped.
const SONNET = {
  maxTokens: 967_000,
  maxOutputTokens: 64_000,
  autoCompactThreshold: 800_000,
}

describe('effective handoff threshold', () => {
  test('leaves a reachable threshold alone', () => {
    const r = effectiveHandoffThreshold({
      configured: 0.8,
      ...SONNET,
      autoCompactEnabled: false,
      turnGrowth: TINY_GROWTH,
    })
    assert.equal(r.clamped, false)
    assert.equal(r.threshold, 0.8)
    assert.equal(r.reason, null)
  })

  test('clamps below the output reserve', () => {
    const r = effectiveHandoffThreshold({
      configured: 0.9,
      ...HAIKU,
      autoCompactEnabled: false,
      turnGrowth: TINY_GROWTH,
    })
    // 1 - 32000/200000 = 0.84, minus the margin.
    assert.equal(r.clamped, true)
    assert.ok(Math.abs(r.threshold - (0.84 - HANDOFF_MARGIN)) < 1e-9)
    assert.match(r.reason ?? '', /reserves 32,000 tokens/)
  })

  test('clamps below auto-compaction when it would fire first', () => {
    const r = effectiveHandoffThreshold({
      configured: 0.9,
      maxTokens: 200_000,
      maxOutputTokens: null,
      autoCompactThreshold: 120_000,
      autoCompactEnabled: true,
      turnGrowth: TINY_GROWTH,
    })
    // 120000/200000 = 0.6, minus the margin.
    assert.equal(r.clamped, true)
    assert.ok(Math.abs(r.threshold - (0.6 - HANDOFF_MARGIN)) < 1e-9)
    assert.match(r.reason ?? '', /auto-compacts at 120,000 tokens/)
  })

  test('the lowest limit is the binding one', () => {
    const r = effectiveHandoffThreshold({
      configured: 0.95,
      maxTokens: 200_000,
      maxOutputTokens: 32_000, // ceiling 0.84
      autoCompactThreshold: 120_000, // ceiling 0.60 — lower, so it wins
      autoCompactEnabled: true,
      turnGrowth: TINY_GROWTH,
    })
    assert.ok(Math.abs(r.threshold - (0.6 - HANDOFF_MARGIN)) < 1e-9)
    assert.match(r.reason ?? '', /auto-compacts/)
  })

  test('a disabled auto-compact threshold is ignored', () => {
    const withIt = effectiveHandoffThreshold({
      configured: 0.8,
      ...HAIKU,
      autoCompactEnabled: true,
      turnGrowth: TINY_GROWTH,
    })
    const withoutIt = effectiveHandoffThreshold({
      configured: 0.8,
      ...HAIKU,
      autoCompactEnabled: false,
      turnGrowth: TINY_GROWTH,
    })
    // 167000/200000 = 0.835; minus the margin that is 0.805, so 0.8 survives
    // either way — but the reported ceiling differs.
    assert.equal(withIt.clamped, false)
    assert.equal(withoutIt.clamped, false)
    assert.ok(withoutIt.ceiling > withIt.ceiling)
  })

  test('the configured value passes through when it equals the ceiling', () => {
    const ceiling = 0.84 - HANDOFF_MARGIN
    const r = effectiveHandoffThreshold({
      configured: ceiling,
      ...HAIKU,
      autoCompactEnabled: false,
      turnGrowth: TINY_GROWTH,
    })
    assert.equal(r.clamped, false)
    assert.equal(r.threshold, ceiling)
  })

  test('never clamps below the floor', () => {
    const r = effectiveHandoffThreshold({
      configured: 0.8,
      maxTokens: 100_000,
      maxOutputTokens: 95_000, // would leave 0.05
      autoCompactThreshold: null,
      autoCompactEnabled: false,
      turnGrowth: TINY_GROWTH,
    })
    assert.equal(r.threshold, MIN_THRESHOLD)
  })

  test('unknown limits leave the threshold untouched', () => {
    const r = effectiveHandoffThreshold({
      configured: 0.8,
      maxTokens: 200_000,
      maxOutputTokens: null,
      autoCompactThreshold: null,
      autoCompactEnabled: false,
      turnGrowth: TINY_GROWTH,
    })
    assert.equal(r.clamped, false)
    assert.equal(r.threshold, 0.8)
  })

  test('a missing window size is not treated as zero', () => {
    const r = effectiveHandoffThreshold({
      configured: 0.8,
      maxTokens: 0,
      maxOutputTokens: 32_000,
      autoCompactThreshold: 167_000,
      autoCompactEnabled: true,
      turnGrowth: TINY_GROWTH,
    })
    assert.equal(r.clamped, false)
    assert.equal(r.threshold, 0.8)
  })

  test('the reason names the number an operator would need to change', () => {
    const r = effectiveHandoffThreshold({
      configured: 0.95,
      ...HAIKU,
      autoCompactEnabled: false,
      turnGrowth: TINY_GROWTH,
    })
    assert.match(r.reason ?? '', /handoffThreshold 95% is not reachable/)
    assert.match(r.reason ?? '', /Using 81% instead/)
  })
})

describe('headroom for a turn', () => {
  // The run that exposed this: turns landed at 64% then 79% — a fifteen point
  // jump — and the turn after that ran out of context. A threshold of 80% under
  // an 84% ceiling was never going to be hit, only jumped over.
  test('keeps a full turn of growth below the ceiling', () => {
    const r = effectiveHandoffThreshold({
      configured: 0.8,
      ...HAIKU,
      autoCompactEnabled: false,
      turnGrowth: 0.15,
    })
    assert.equal(r.clamped, true)
    assert.ok(Math.abs(r.threshold - (0.84 - 0.15)) < 1e-9)
    assert.ok(r.threshold + 0.15 <= r.ceiling + 1e-9, 'one more turn must still fit')
  })

  test('assumes a turn of growth before the run has measured one', () => {
    const r = effectiveHandoffThreshold({
      configured: 0.8,
      ...HAIKU,
      autoCompactEnabled: false,
      turnGrowth: null,
    })
    assert.equal(r.headroom, ASSUMED_TURN_GROWTH)
    assert.ok(Math.abs(r.threshold - (0.84 - ASSUMED_TURN_GROWTH)) < 1e-9)
    assert.match(r.reason ?? '', /is assumed to add/)
  })

  test('a measured jump larger than the assumption lowers the threshold further', () => {
    const assumed = effectiveHandoffThreshold({
      configured: 0.8,
      ...HAIKU,
      autoCompactEnabled: false,
      turnGrowth: null,
    })
    const measured = effectiveHandoffThreshold({
      configured: 0.8,
      ...HAIKU,
      autoCompactEnabled: false,
      turnGrowth: 0.3,
    })
    assert.ok(measured.threshold < assumed.threshold)
    assert.match(measured.reason ?? '', /has been seen to add/)
  })

  test('a measured jump smaller than the margin does not widen the threshold', () => {
    const r = effectiveHandoffThreshold({
      configured: 0.95,
      ...HAIKU,
      autoCompactEnabled: false,
      turnGrowth: 0.001,
    })
    assert.equal(r.headroom, HANDOFF_MARGIN)
  })

  test('a clamp resting only on the assumption is marked provisional', () => {
    // The run that exposed this: on a million-token window the assumed fifteen
    // point turn briefly pushed 80% below the line and logged that it was "not
    // reachable" — then the first measurement put it straight back to 80%. The
    // clamp is still worth applying; the alarm was not.
    const provisional = effectiveHandoffThreshold({
      configured: 0.8,
      ...SONNET,
      autoCompactEnabled: false,
      turnGrowth: null,
    })
    assert.equal(provisional.clamped, true)
    assert.equal(provisional.provisional, true)
    assert.match(provisional.reason ?? '', /may not be reachable/)
    assert.match(provisional.reason ?? '', /rises again if turns turn out smaller/)

    // Once measured, the same configuration is fine again.
    const measured = effectiveHandoffThreshold({
      configured: 0.8,
      ...SONNET,
      autoCompactEnabled: false,
      turnGrowth: 0.01,
    })
    assert.equal(measured.clamped, false)
    assert.equal(measured.threshold, 0.8)
  })

  test('a clamp that would happen anyway is not provisional', () => {
    // 95% is above the ceiling even with only the minimum margin, so no
    // measurement can rescue it.
    const r = effectiveHandoffThreshold({
      configured: 0.95,
      ...HAIKU,
      autoCompactEnabled: false,
      turnGrowth: null,
    })
    assert.equal(r.clamped, true)
    assert.equal(r.provisional, false)
    assert.match(r.reason ?? '', /is not reachable/)
  })

  test('a measured clamp is never provisional', () => {
    const r = effectiveHandoffThreshold({
      configured: 0.8,
      ...HAIKU,
      autoCompactEnabled: false,
      turnGrowth: 0.15,
    })
    assert.equal(r.clamped, true)
    assert.equal(r.provisional, false)
  })

  test('a roomy window still takes the configured threshold', () => {
    // On a million-token window a fifteen point turn is not possible in one go,
    // and the ceiling sits at 93%, so nothing binds.
    const r = effectiveHandoffThreshold({
      configured: 0.8,
      ...SONNET,
      autoCompactEnabled: false,
      turnGrowth: 0.05,
    })
    assert.equal(r.clamped, false)
    assert.equal(r.threshold, 0.8)
  })
})

describe('picking the model output budget', () => {
  test('prefers the entry for the session model', () => {
    const usage = {
      'claude-haiku-4-5': { maxOutputTokens: 32_000 },
      'claude-sonnet-5': { maxOutputTokens: 64_000 },
    }
    assert.equal(pickMaxOutputTokens(usage, 'claude-haiku-4-5'), 32_000)
  })

  test('falls back to the largest budget when the model is unknown', () => {
    const usage = {
      'claude-haiku-4-5': { maxOutputTokens: 32_000 },
      'claude-sonnet-5': { maxOutputTokens: 64_000 },
    }
    assert.equal(pickMaxOutputTokens(usage, null), 64_000)
    assert.equal(pickMaxOutputTokens(usage, 'some-other-model'), 64_000)
  })

  test('returns null when nothing usable is present', () => {
    assert.equal(pickMaxOutputTokens(undefined, 'x'), null)
    assert.equal(pickMaxOutputTokens({}, 'x'), null)
    assert.equal(pickMaxOutputTokens({ m: {} }, 'm'), null)
    assert.equal(pickMaxOutputTokens({ m: { maxOutputTokens: 0 } }, 'm'), null)
  })
})
