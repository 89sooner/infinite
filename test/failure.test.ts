import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import { describeFailure } from '../src/orchestrator.ts'

function result(over: Record<string, unknown> = {}): SDKResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 3,
    result: '',
    stop_reason: null,
    total_cost_usd: 0,
    usage: {} as never,
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000000',
    session_id: 's',
    ...over,
  } as SDKResultMessage
}

describe('failure description', () => {
  // The line this replaces read "turn failed: success", because it printed the
  // subtype alone while the error was flagged elsewhere.
  test('reports the flag and the subtype together', () => {
    const text = describeFailure(result())
    assert.match(text, /subtype=success/)
    assert.match(text, /is_error=true/)
    assert.notEqual(text.trim(), 'success')
  })

  test('includes the fields that carry a signal when present', () => {
    const text = describeFailure(
      result({
        subtype: 'error_during_execution',
        stop_reason: 'max_tokens',
        api_error_status: 400,
        terminal_reason: 'context_exceeded',
        num_turns: 7,
      }),
    )
    assert.match(text, /subtype=error_during_execution/)
    assert.match(text, /stop_reason=max_tokens/)
    assert.match(text, /http=400/)
    assert.match(text, /terminal_reason=context_exceeded/)
    assert.match(text, /turns=7/)
  })

  test('omits fields that are absent rather than printing null', () => {
    const text = describeFailure(result())
    assert.ok(!text.includes('stop_reason='))
    assert.ok(!text.includes('http='))
    assert.ok(!text.includes('null'))
  })

  test('carries the response text, flattened and bounded', () => {
    const text = describeFailure(result({ result: `prompt is too long\n\n${'x'.repeat(500)}` }))
    assert.match(text, /text="prompt is too long/)
    assert.ok(!text.includes('\n'))
    assert.ok(text.length < 450)
    assert.ok(text.includes('…'))
  })

  test('leaves out an empty response instead of an empty quote', () => {
    assert.ok(!describeFailure(result({ result: '   ' })).includes('text='))
  })
})
