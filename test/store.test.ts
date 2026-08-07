import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { Store } from '../src/store.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'infinite-store-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function newStore(): Store {
  return new Store(loadConfig({ cwd: dir }), { quiet: true })
}

describe('persistence', () => {
  test('state survives a restart', () => {
    const store = newStore()
    store.update((s) => {
      s.totalTurns = 7
      s.totalCostUsd = 1.25
    })
    store.flush()

    const reopened = newStore()
    assert.equal(reopened.state.totalTurns, 7)
    assert.equal(reopened.state.totalCostUsd, 1.25)
  })

  test('a run killed mid-flight does not reload as running', () => {
    const store = newStore()
    store.update((s) => {
      s.status = 'running'
    })
    store.flush()
    assert.equal(newStore().state.status, 'stopped')
  })

  test('corrupt state is set aside rather than blocking a restart', () => {
    const store = newStore()
    store.flush()
    writeFileSync(store.stateFile, 'not json at all')

    const reopened = newStore()
    assert.equal(reopened.state.status, 'idle')
    const salvaged = readdirSync(join(dir, '.infinite')).filter((f) => f.includes('.corrupt-'))
    assert.equal(salvaged.length, 1)
  })

  test('state written before notifications existed still loads', () => {
    const store = newStore()
    store.flush()
    const raw = JSON.parse(readFileSync(store.stateFile, 'utf8')) as Record<string, unknown>
    delete raw.notifications
    writeFileSync(store.stateFile, JSON.stringify(raw))

    const reopened = newStore()
    assert.equal(reopened.state.notifications.muted, false)
    assert.deepEqual(reopened.state.notifications.disabledChannels, [])
    assert.ok(reopened.state.notifications.events.includes('handoff'))
  })

  test('runtime notification settings round-trip', () => {
    const store = newStore()
    store.update((s) => {
      s.notifications.muted = true
      s.notifications.disabledChannels = ['knox']
    })
    store.flush()

    const reopened = newStore()
    assert.equal(reopened.state.notifications.muted, true)
    assert.deepEqual(reopened.state.notifications.disabledChannels, ['knox'])
  })
})

describe('events', () => {
  test('logged events are readable back from the audit log', () => {
    const store = newStore()
    store.info('leg', 'session 1 starting')
    store.warn('notify', 'channel down')

    const events = newStore().recentEvents()
    assert.equal(events.length, 2)
    assert.equal(events[0].kind, 'leg')
    assert.equal(events[1].level, 'warn')
  })

  test('subscribers are notified of state and events', () => {
    const store = newStore()
    let states = 0
    let logs = 0
    store.on('state', () => states++)
    store.on('event', () => logs++)

    store.update((s) => {
      s.totalTurns = 1
    })
    store.info('test', 'hello')

    assert.equal(states, 1)
    assert.equal(logs, 1)
  })
})

describe('handoffs', () => {
  test('paths are zero padded and stable', () => {
    const store = newStore()
    assert.ok(store.handoffPath(4).endsWith('leg-004.md'))
    assert.ok(store.handoffPath(120).endsWith('leg-120.md'))
  })

  test('reading a missing handoff returns null', () => {
    assert.equal(newStore().readHandoff(9), null)
  })

  test('the handoff directory is created up front', () => {
    newStore()
    assert.ok(existsSync(join(dir, '.infinite', 'handoffs')))
  })
})
