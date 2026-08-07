import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { renderString, renderTemplate, redactUrl } from '../src/notify/render.ts'
import { WebhookChannel, CommandChannel, createChannel } from '../src/notify/channels.ts'
import type { NotifyPayload } from '../src/notify/types.ts'

const payload: NotifyPayload = {
  event: 'handoff',
  severity: 'info',
  title: '[infinite/app] session 2 handing off',
  text: 'Context 81.0%.',
  at: '2026-01-01T00:00:00Z',
  host: 'infra01',
  project: 'app',
  mission: 'Ship the thing.',
  status: 'running',
  leg: 2,
  legOutcome: null,
  legSummary: null,
  reason: 'context',
  contextPct: 81,
  contextTokens: 162_000,
  contextMaxTokens: 200_000,
  totalCostUsd: 12.5,
  totalTurns: 40,
  totalLegs: 2,
  dashboardUrl: 'http://infra01:4319',
}

describe('template rendering', () => {
  test('substitutes payload fields', () => {
    assert.equal(renderString('{{project}} at {{contextPct}}%', payload), 'app at 81%')
  })

  test('leaves unknown placeholders visible instead of blanking them', () => {
    // A typo should be obvious in the delivered message, not silently swallowed.
    assert.equal(renderString('{{nope}}', payload), '{{nope}}')
  })

  test('renders null fields as empty', () => {
    assert.equal(renderString('[{{legOutcome}}]', payload), '[]')
  })

  test('tolerates whitespace inside the braces', () => {
    assert.equal(renderString('{{ project }}', payload), 'app')
  })

  test('walks nested objects and arrays', () => {
    const out = renderTemplate(
      { text: '{{title}}', meta: { host: '{{host}}', tags: ['{{event}}', 'static'] }, n: 5 },
      payload,
    )
    assert.deepEqual(out, {
      text: '[infinite/app] session 2 handing off',
      meta: { host: 'infra01', tags: ['handoff', 'static'] },
      n: 5,
    })
  })
})

describe('url redaction', () => {
  test('masks passwords and secret-ish query parameters', () => {
    assert.ok(!redactUrl('https://user:hunter2@knox.example.com/send').includes('hunter2'))
    assert.ok(!redactUrl('https://knox.example.com/send?token=abc123').includes('abc123'))
    assert.ok(!redactUrl('https://knox.example.com/send?api_key=xyz').includes('xyz'))
  })

  test('leaves ordinary parameters alone', () => {
    assert.ok(redactUrl('https://knox.example.com/send?room=ops').includes('room=ops'))
  })

  test('returns unparseable input unchanged', () => {
    assert.equal(redactUrl('not a url'), 'not a url')
  })
})

describe('channel construction', () => {
  test('knox and webhook both build a webhook channel', () => {
    const base = { name: 'k', enabled: true, url: 'http://x.test/y' }
    assert.ok(createChannel({ ...base, kind: 'knox' }) instanceof WebhookChannel)
    assert.ok(createChannel({ ...base, kind: 'webhook' }) instanceof WebhookChannel)
  })

  test('command builds a command channel', () => {
    const ch = createChannel({ name: 'c', kind: 'command', enabled: true, command: '/bin/true' })
    assert.ok(ch instanceof CommandChannel)
  })

  test('an unknown kind is rejected', () => {
    assert.throws(
      () => createChannel({ name: 'x', kind: 'carrier-pigeon', enabled: true } as never),
      /unknown notification channel kind/,
    )
  })

  test('the reported target never carries credentials', () => {
    const ch = createChannel({
      name: 'k',
      kind: 'knox',
      enabled: true,
      url: 'https://knox.example.com/send?token=supersecret',
    })
    assert.ok(!ch.target().includes('supersecret'))
  })
})

describe('webhook delivery', () => {
  let server: Server
  let port = 0
  const received: { url: string; auth: string | undefined; body: string }[] = []

  before(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      received.push({
        url: req.url ?? '',
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      })
      if (req.url === '/boom') {
        res.writeHead(500)
        res.end('upstream exploded')
        return
      }
      res.writeHead(200)
      res.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  })

  after(() => server.close())

  test('posts the rendered body with rendered headers', async () => {
    const ch = new WebhookChannel({
      name: 'k',
      kind: 'knox',
      enabled: true,
      url: `http://127.0.0.1:${port}/send`,
      headers: { Authorization: 'Bearer tok', 'X-Project': '{{project}}' },
      bodyTemplate: { text: '{{title}}' },
    })
    await ch.send(payload)

    const last = received.at(-1)
    assert.equal(last?.auth, 'Bearer tok')
    assert.deepEqual(JSON.parse(last?.body ?? '{}'), {
      text: '[infinite/app] session 2 handing off',
    })
  })

  test('sends the whole payload when no template is given', async () => {
    const ch = new WebhookChannel({
      name: 'k',
      kind: 'webhook',
      enabled: true,
      url: `http://127.0.0.1:${port}/raw`,
    })
    await ch.send(payload)
    assert.equal(JSON.parse(received.at(-1)?.body ?? '{}').event, 'handoff')
  })

  test('a non-2xx response throws with the status and body', async () => {
    const ch = new WebhookChannel({
      name: 'k',
      kind: 'webhook',
      enabled: true,
      url: `http://127.0.0.1:${port}/boom`,
    })
    await assert.rejects(() => ch.send(payload), /HTTP 500.*upstream exploded/s)
  })
})

describe('command delivery', () => {
  test('passes the payload on stdin and succeeds on exit 0', async () => {
    const ch = new CommandChannel({
      name: 'c',
      kind: 'command',
      enabled: true,
      command: '/bin/cat',
    })
    await ch.send(payload)
  })

  test('a non-zero exit throws with stderr', async () => {
    const ch = new CommandChannel({
      name: 'c',
      kind: 'command',
      enabled: true,
      command: '/bin/sh',
      args: ['-c', 'echo nope >&2; exit 3'],
    })
    await assert.rejects(() => ch.send(payload), /exit 3.*nope/s)
  })

  test('succeeds when the command never reads stdin', async () => {
    // The pipe closes under us and the write fails with EPIPE. A wrapper that
    // ignores stdin is perfectly normal, so exit 0 must still count as success.
    const ch = new CommandChannel({
      name: 'c',
      kind: 'command',
      enabled: true,
      command: '/bin/sh',
      args: ['-c', 'exit 0'],
    })
    await ch.send(payload)
  })

  test('a missing executable surfaces as an error', async () => {
    const ch = new CommandChannel({
      name: 'c',
      kind: 'command',
      enabled: true,
      command: '/nonexistent/binary',
    })
    await assert.rejects(() => ch.send(payload))
  })
})
