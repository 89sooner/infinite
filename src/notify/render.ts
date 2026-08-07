import type { NotifyPayload } from './types.ts'

/**
 * Substitutes `{{field}}` placeholders from the payload. Unknown fields are left
 * untouched rather than blanked, so a typo in a template is visible in the
 * delivered message instead of silently vanishing.
 */
export function renderString(template: string, payload: NotifyPayload): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (whole, key: string) => {
    if (!(key in payload)) return whole
    const value = (payload as unknown as Record<string, unknown>)[key]
    if (value === null || value === undefined) return ''
    return String(value)
  })
}

/** Walks a JSON template and renders every string it contains. */
export function renderTemplate(template: unknown, payload: NotifyPayload): unknown {
  if (typeof template === 'string') return renderString(template, payload)
  if (Array.isArray(template)) return template.map((item) => renderTemplate(item, payload))
  if (typeof template === 'object' && template !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(template)) {
      out[renderString(k, payload)] = renderTemplate(v, payload)
    }
    return out
  }
  return template
}

/** Hides credentials in header values before anything reaches the dashboard. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    for (const key of [...u.searchParams.keys()]) {
      if (/token|key|secret|auth|sig/i.test(key)) u.searchParams.set(key, '***')
    }
    return u.toString()
  } catch {
    return url
  }
}
