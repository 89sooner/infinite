import { spawn } from 'node:child_process'
import type {
  Channel,
  ChannelConfig,
  CommandChannelConfig,
  NotifyPayload,
  WebhookChannelConfig,
} from './types.ts'
import { renderString, renderTemplate, redactUrl } from './render.ts'

/**
 * Posts JSON to an HTTP endpoint. This is the extension point: a new messenger
 * normally needs no code, only a `url`, `headers` and a `bodyTemplate` that
 * matches its API.
 */
export class WebhookChannel implements Channel {
  readonly name: string
  readonly kind: 'webhook' | 'knox'
  readonly config: WebhookChannelConfig

  constructor(config: WebhookChannelConfig) {
    this.name = config.name
    this.kind = config.kind
    this.config = config
  }

  target(): string {
    return redactUrl(this.config.url)
  }

  async send(payload: NotifyPayload): Promise<void> {
    const url = renderString(this.config.url, payload)
    const body =
      this.config.bodyTemplate === undefined
        ? payload
        : renderTemplate(this.config.bodyTemplate, payload)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
    }
    for (const [k, v] of Object.entries(this.config.headers ?? {})) {
      headers[k] = renderString(v, payload)
    }

    const res = await fetch(url, {
      method: this.config.method ?? 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
    })

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
    }
  }
}

/**
 * Runs a local executable with the payload on stdin. For networks where the
 * messenger is only reachable through a wrapper binary, an mTLS proxy, or a CLI
 * that already holds the credentials.
 */
export class CommandChannel implements Channel {
  readonly name: string
  readonly kind = 'command' as const
  readonly config: CommandChannelConfig

  constructor(config: CommandChannelConfig) {
    this.name = config.name
    this.config = config
  }

  target(): string {
    return this.config.command
  }

  send(payload: NotifyPayload): Promise<void> {
    const args = (this.config.args ?? []).map((a) => renderString(a, payload))
    const timeout = this.config.timeoutMs ?? 10_000

    return new Promise((resolve, reject) => {
      // No shell: arguments are passed as an argv array, so payload text cannot
      // be interpreted as shell syntax.
      const child = spawn(this.config.command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout,
      })

      let stderr = ''
      child.stderr.on('data', (c: Buffer) => {
        stderr += c.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`exit ${code}${stderr ? ` — ${stderr.trim().slice(0, 300)}` : ''}`))
      })

      if (this.config.stdin === false) {
        child.stdin.end()
      } else {
        child.stdin.end(JSON.stringify(payload))
      }
    })
  }
}

export function createChannel(config: ChannelConfig): Channel {
  switch (config.kind) {
    case 'webhook':
    case 'knox':
      return new WebhookChannel(config)
    case 'command':
      return new CommandChannel(config)
    default: {
      const kind = (config as { kind: string }).kind
      throw new Error(`unknown notification channel kind "${kind}"`)
    }
  }
}
