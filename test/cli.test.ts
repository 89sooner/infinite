import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'infinite-cli-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function cli(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, NO_COLOR: '1' },
    })
    return { stdout, stderr, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

describe('cli', () => {
  test('--help lists the commands', async () => {
    const { stdout, code } = await cli('--help')
    assert.equal(code, 0)
    for (const command of ['run', 'status', 'init', 'handoff', 'notify-test', 'notify']) {
      assert.ok(stdout.includes(command), `help does not mention "${command}"`)
    }
  })

  test('init writes a usable config and mission', async () => {
    const { stdout, code } = await cli('init', '--cwd', dir)
    assert.equal(code, 0)
    assert.ok(stdout.includes('infinite.config.json'))

    assert.ok(existsSync(join(dir, 'infinite.config.json')))
    assert.ok(existsSync(join(dir, 'MISSION.md')))
    assert.ok(existsSync(join(dir, 'HANDOFF.template.md')))

    const config = JSON.parse(readFileSync(join(dir, 'infinite.config.json'), 'utf8'))
    assert.equal(config.handoffThreshold, 0.8)
    // The generated config must load without any environment set up, so it
    // cannot ship channels that reference ${VAR}.
    assert.deepEqual(config.notifications.channels, [])
  })

  test('init does not clobber existing files', async () => {
    await cli('init', '--cwd', dir)
    const mission = join(dir, 'MISSION.md')
    const before = readFileSync(mission, 'utf8')

    const { stdout } = await cli('init', '--cwd', dir)
    assert.ok(stdout.includes('kept existing'))
    assert.equal(readFileSync(mission, 'utf8'), before)
  })

  test('a generated project reports status without error', async () => {
    await cli('init', '--cwd', dir)
    const { stdout, code } = await cli('status', '--cwd', dir)
    assert.equal(code, 0)
    assert.ok(stdout.includes('status'))
    assert.ok(stdout.includes('threshold'))
  })

  test('an unknown command fails with usage', async () => {
    const { stderr, code } = await cli('flibbertigibbet', '--cwd', dir)
    assert.equal(code, 1)
    assert.ok(stderr.includes('unknown command'))
  })

  test('run without a mission file explains what is missing', async () => {
    const { stderr, code } = await cli('run', '--cwd', dir)
    assert.equal(code, 1)
    assert.ok(stderr.includes('Mission file not found'))
  })

  test('an out-of-range threshold is rejected before anything starts', async () => {
    const { stderr, code } = await cli('run', '--cwd', dir, '--threshold', '0.99')
    assert.equal(code, 1)
    assert.ok(stderr.includes('no room to write the handoff'))
  })

  test('handoff requires a session number', async () => {
    await cli('init', '--cwd', dir)
    const { stderr, code } = await cli('handoff', '--cwd', dir)
    assert.equal(code, 1)
    assert.ok(stderr.includes('usage: infinite handoff'))
  })

  test('notify toggles mute and persists it', async () => {
    await cli('init', '--cwd', dir)
    const off = await cli('notify', 'off', '--cwd', dir)
    assert.equal(off.code, 0)

    const state = JSON.parse(readFileSync(join(dir, '.infinite', 'state.json'), 'utf8'))
    assert.equal(state.notifications.muted, true)

    await cli('notify', 'on', '--cwd', dir)
    const after = JSON.parse(readFileSync(join(dir, '.infinite', 'state.json'), 'utf8'))
    assert.equal(after.notifications.muted, false)
  })

  test('notify rejects anything but on and off', async () => {
    const { stderr, code } = await cli('notify', 'sometimes', '--cwd', dir)
    assert.equal(code, 1)
    assert.ok(stderr.includes('usage: infinite notify'))
  })

  test('notify-test reports when nothing is configured', async () => {
    await cli('init', '--cwd', dir)
    const { stdout, code } = await cli('notify-test', '--cwd', dir)
    assert.equal(code, 1)
    assert.ok(stdout.includes('No enabled channels'))
  })
})
