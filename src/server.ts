import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Store } from './store.ts'
import type { Orchestrator } from './orchestrator.ts'
import type { Event, InfiniteConfig, RunState } from './types.ts'
import type { ChannelStatus, NotifyEventName } from './notify/types.ts'
import { ALL_EVENTS } from './notify/types.ts'
import { dashboardHtml } from './ui.ts'

type Snapshot = RunState & {
  config: { handoffThreshold: number; maxLegs: number }
  channels: ChannelStatus[]
}

export function startServer(
  cfg: InfiniteConfig,
  store: Store,
  orch: Orchestrator,
): Server {
  const html = dashboardHtml()

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      store.error('server', `request failed: ${(err as Error).message}`)
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(html)
      return
    }

    if (!authorized(cfg, req, url)) {
      send(res, 401, { error: 'unauthorized' })
      return
    }

    if (path === '/api/state' && req.method === 'GET') {
      send(res, 200, snapshot(cfg, store, orch))
      return
    }

    if (path === '/api/events' && req.method === 'GET') {
      streamEvents(res, cfg, store, orch)
      return
    }

    if (path.startsWith('/api/handoff/') && req.method === 'GET') {
      const n = Number(path.split('/').pop())
      const body = Number.isFinite(n) ? store.readHandoff(n) : null
      if (body === null) {
        send(res, 404, { error: 'no handoff for that session' })
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(body)
      return
    }

    if (path === '/api/tasks' && req.method === 'POST') {
      const body = await readJson(req)
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text) {
        send(res, 400, { error: 'text is required' })
        return
      }
      orch.addTask(text)
      send(res, 200, { ok: true })
      return
    }

    if (path === '/api/notifications' && req.method === 'POST') {
      const body = await readJson(req)
      const action = String(body.action ?? '')
      const channel = typeof body.channel === 'string' ? body.channel : null

      switch (action) {
        case 'mute':
          orch.notifier.setMuted(true)
          break
        case 'unmute':
          orch.notifier.setMuted(false)
          break
        case 'enable':
        case 'disable': {
          if (!channel) {
            send(res, 400, { error: 'channel is required' })
            return
          }
          if (!orch.notifier.setChannelEnabled(channel, action === 'enable')) {
            send(res, 404, { error: `no channel named "${channel}"` })
            return
          }
          break
        }
        case 'events': {
          const raw = Array.isArray(body.events) ? body.events : null
          if (!raw) {
            send(res, 400, { error: 'events must be an array' })
            return
          }
          const unknown = raw.filter((e) => !ALL_EVENTS.includes(e as NotifyEventName))
          if (unknown.length > 0) {
            send(res, 400, { error: `unknown events: ${unknown.join(', ')}` })
            return
          }
          orch.notifier.setEvents(raw as NotifyEventName[])
          break
        }
        case 'test': {
          const results = await orch.notifier.test()
          send(res, 200, { ok: true, results })
          return
        }
        default:
          send(res, 400, { error: `unknown action "${action}"` })
          return
      }

      send(res, 200, { ok: true, channels: orch.notifier.status() })
      return
    }

    if (path === '/api/control' && req.method === 'POST') {
      const body = await readJson(req)
      const action = String(body.action ?? '')
      switch (action) {
        case 'pause':
          orch.pause()
          break
        case 'resume':
          orch.resume()
          break
        case 'handoff':
          orch.requestHandoff()
          break
        case 'stop':
          orch.stop()
          break
        default:
          send(res, 400, { error: `unknown action "${action}"` })
          return
      }
      send(res, 200, { ok: true })
      return
    }

    send(res, 404, { error: 'not found' })
  }

  server.listen(cfg.server.port, cfg.server.host, () => {
    const base = `http://${cfg.server.host}:${cfg.server.port}`
    const link = cfg.server.token ? `${base}/?token=${cfg.server.token}` : base
    store.info('server', `dashboard on ${link}`)
    if (!cfg.server.token && cfg.server.host !== '127.0.0.1' && cfg.server.host !== 'localhost') {
      store.warn(
        'server',
        `bound to ${cfg.server.host} with no token — set server.token or INFINITE_TOKEN`,
      )
    }
  })

  return server
}

function snapshot(cfg: InfiniteConfig, store: Store, orch: Orchestrator): Snapshot {
  return {
    ...store.state,
    config: { handoffThreshold: cfg.handoffThreshold, maxLegs: cfg.maxLegs },
    // Channel status is already redacted — it never carries urls with
    // credentials or header values.
    channels: orch.notifier.status(),
  }
}

function streamEvents(
  res: ServerResponse,
  cfg: InfiniteConfig,
  store: Store,
  orch: Orchestrator,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  const write = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  write('history', store.recentEvents(200))
  write('state', snapshot(cfg, store, orch))

  const onState = (_s: RunState) => write('state', snapshot(cfg, store, orch))
  const onEvent = (e: Event) => write('log', e)
  store.on('state', onState)
  store.on('event', onEvent)

  // Proxies drop idle streams; a comment frame is enough to keep them open.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  ping.unref?.()

  res.on('close', () => {
    clearInterval(ping)
    store.off('state', onState)
    store.off('event', onEvent)
  })
}

function authorized(cfg: InfiniteConfig, req: IncomingMessage, url: URL): boolean {
  const expected = cfg.server.token
  if (!expected) return true
  const header = req.headers.authorization ?? ''
  const provided = header.startsWith('Bearer ')
    ? header.slice(7)
    : (url.searchParams.get('token') ?? '')
  return safeEqual(provided, expected)
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}
