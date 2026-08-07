import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'infinite-cfg-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.INFINITE_THRESHOLD
  delete process.env.KNOX_TOKEN
})

function writeConfig(config: unknown): void {
  writeFileSync(join(dir, 'infinite.config.json'), JSON.stringify(config))
}

describe('defaults', () => {
  test('resolves paths relative to cwd', () => {
    const cfg = loadConfig({ cwd: dir })
    assert.equal(cfg.handoffThreshold, 0.8)
    assert.equal(cfg.missionFile, join(dir, 'MISSION.md'))
    assert.equal(cfg.stateDir, join(dir, '.infinite'))
    assert.equal(cfg.notifications.enabled, false)
  })

  test('binds the dashboard to loopback by default', () => {
    assert.equal(loadConfig({ cwd: dir }).server.host, '127.0.0.1')
  })
})

describe('merging', () => {
  test('a config file overrides defaults', () => {
    writeConfig({ handoffThreshold: 0.6, maxLegs: 3 })
    const cfg = loadConfig({ cwd: dir })
    assert.equal(cfg.handoffThreshold, 0.6)
    assert.equal(cfg.maxLegs, 3)
  })

  test('nested objects merge instead of replacing wholesale', () => {
    writeConfig({ server: { port: 5000 } })
    const cfg = loadConfig({ cwd: dir })
    assert.equal(cfg.server.port, 5000)
    // host was not specified and must survive.
    assert.equal(cfg.server.host, '127.0.0.1')
  })

  test('explicit overrides beat the file', () => {
    writeConfig({ handoffThreshold: 0.6 })
    const cfg = loadConfig({ cwd: dir, overrides: { handoffThreshold: 0.5 } })
    assert.equal(cfg.handoffThreshold, 0.5)
  })

  test('the environment beats both', () => {
    writeConfig({ handoffThreshold: 0.6 })
    process.env.INFINITE_THRESHOLD = '0.4'
    assert.equal(loadConfig({ cwd: dir }).handoffThreshold, 0.4)
  })

  test('malformed json names the file', () => {
    writeFileSync(join(dir, 'infinite.config.json'), '{ not json')
    assert.throws(() => loadConfig({ cwd: dir }), /Could not parse/)
  })
})

describe('validation', () => {
  test('rejects a threshold outside the open unit interval', () => {
    writeConfig({ handoffThreshold: 0 })
    assert.throws(() => loadConfig({ cwd: dir }), /between 0 and 1/)
    writeConfig({ handoffThreshold: 1 })
    assert.throws(() => loadConfig({ cwd: dir }), /between 0 and 1/)
  })

  test('rejects a threshold that leaves no room to write the handoff', () => {
    writeConfig({ handoffThreshold: 0.95 })
    assert.throws(() => loadConfig({ cwd: dir }), /no room to write the handoff/)
  })

  test('rejects an unknown tool policy fallback', () => {
    writeConfig({ toolPolicy: { fallback: 'maybe' } })
    assert.throws(() => loadConfig({ cwd: dir }), /must be "allow" or "deny"/)
  })
})

describe('environment expansion', () => {
  test('expands ${VAR} inside the config file', () => {
    process.env.KNOX_TOKEN = 'tok-123'
    writeConfig({
      notifications: {
        enabled: true,
        channels: [
          {
            name: 'knox',
            kind: 'knox',
            enabled: true,
            url: 'https://knox.example.com/send',
            headers: { Authorization: 'Bearer ${KNOX_TOKEN}' },
          },
        ],
      },
    })
    const cfg = loadConfig({ cwd: dir })
    const channel = cfg.notifications.channels[0]
    assert.equal(
      (channel as { headers: Record<string, string> }).headers.Authorization,
      'Bearer tok-123',
    )
  })

  test('a missing variable aborts and says where it was referenced', () => {
    writeConfig({
      notifications: {
        enabled: true,
        channels: [
          {
            name: 'knox',
            kind: 'knox',
            enabled: true,
            url: 'https://knox.example.com/send',
            headers: { Authorization: 'Bearer ${KNOX_TOKEN}' },
          },
        ],
      },
    })
    assert.throws(
      () => loadConfig({ cwd: dir }),
      /\$\{KNOX_TOKEN\}.*notifications\.channels\[0\]\.headers\.Authorization/s,
    )
  })

  test('leaves {{field}} message placeholders untouched', () => {
    writeConfig({
      notifications: {
        enabled: true,
        channels: [
          {
            name: 'knox',
            kind: 'knox',
            enabled: true,
            url: 'https://knox.example.com/send',
            bodyTemplate: { text: '{{title}}' },
          },
        ],
      },
    })
    const cfg = loadConfig({ cwd: dir })
    const channel = cfg.notifications.channels[0] as { bodyTemplate: { text: string } }
    assert.equal(channel.bodyTemplate.text, '{{title}}')
  })
})

describe('notification validation', () => {
  function withChannels(channels: unknown[]): void {
    writeConfig({ notifications: { enabled: true, channels } })
  }

  test('rejects duplicate channel names', () => {
    const channel = { name: 'k', kind: 'knox', enabled: true, url: 'https://a.test/x' }
    withChannels([channel, { ...channel }])
    assert.throws(() => loadConfig({ cwd: dir }), /duplicate notification channel name/)
  })

  test('rejects a webhook channel with no url', () => {
    withChannels([{ name: 'k', kind: 'knox', enabled: true }])
    assert.throws(() => loadConfig({ cwd: dir }), /needs a "url"/)
  })

  test('rejects an invalid url', () => {
    withChannels([{ name: 'k', kind: 'webhook', enabled: true, url: 'nope' }])
    assert.throws(() => loadConfig({ cwd: dir }), /invalid url/)
  })

  test('rejects a command channel with no command', () => {
    withChannels([{ name: 'c', kind: 'command', enabled: true }])
    assert.throws(() => loadConfig({ cwd: dir }), /needs a "command"/)
  })

  test('rejects an unknown channel kind', () => {
    withChannels([{ name: 'x', kind: 'smoke-signal', enabled: true }])
    assert.throws(() => loadConfig({ cwd: dir }), /unknown kind/)
  })

  test('rejects an unknown event name', () => {
    writeConfig({ notifications: { events: ['handoff', 'nonsense'] } })
    assert.throws(() => loadConfig({ cwd: dir }), /unknown event "nonsense"/)
  })

  test('rejects an unknown event on a channel', () => {
    withChannels([
      { name: 'k', kind: 'knox', enabled: true, url: 'https://a.test/x', events: ['bogus'] },
    ])
    assert.throws(() => loadConfig({ cwd: dir }), /unknown event "bogus"/)
  })

  test('rejects notifications enabled with no channels', () => {
    writeConfig({ notifications: { enabled: true, channels: [] } })
    assert.throws(() => loadConfig({ cwd: dir }), /channels is empty/)
  })

  test('accepts a valid configuration', () => {
    withChannels([{ name: 'k', kind: 'knox', enabled: true, url: 'https://a.test/x' }])
    const cfg = loadConfig({ cwd: dir })
    assert.equal(cfg.notifications.channels.length, 1)
  })
})
