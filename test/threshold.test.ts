import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveHandoffThreshold,
  pickMaxOutputTokens,
  HANDOFF_MARGIN,
  MIN_THRESHOLD,
} from '../src/threshold.ts'

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
    })
    assert.ok(Math.abs(r.threshold - (0.6 - HANDOFF_MARGIN)) < 1e-9)
    assert.match(r.reason ?? '', /auto-compacts/)
  })

  test('a disabled auto-compact threshold is ignored', () => {
    const withIt = effectiveHandoffThreshold({
      configured: 0.8,
      ...HAIKU,
      autoCompactEnabled: true,
    })
    const withoutIt = effectiveHandoffThreshold({
      configured: 0.8,
      ...HAIKU,
      autoCompactEnabled: false,
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
    })
    assert.equal(r.clamped, false)
    assert.equal(r.threshold, 0.8)
  })

  test('the reason names the number an operator would need to change', () => {
    const r = effectiveHandoffThreshold({
      configured: 0.95,
      ...HAIKU,
      autoCompactEnabled: false,
    })
    assert.match(r.reason ?? '', /handoffThreshold 95% is not reachable/)
    assert.match(r.reason ?? '', /Using 81% instead/)
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
