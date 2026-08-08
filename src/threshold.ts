/**
 * Room left below the ceiling for the handoff turn itself. The handoff response
 * is short — the document goes to a file — so this only has to cover the prompt
 * and a little slack.
 */
export const HANDOFF_MARGIN = 0.03

/** Never clamp below this; a threshold this low would restart constantly. */
export const MIN_THRESHOLD = 0.25

export type ThresholdInput = {
  /** The operator's configured threshold, as a fraction of the context window. */
  configured: number
  /** Size of the context window in tokens. */
  maxTokens: number
  /**
   * Tokens the model may still emit. They have to fit alongside the context, so
   * they are unusable for conversation and shrink the real ceiling.
   */
  maxOutputTokens: number | null
  /** Token count at which Claude Code compacts on its own, if it is enabled. */
  autoCompactThreshold: number | null
  autoCompactEnabled: boolean
}

export type ThresholdResult = {
  /** The threshold to actually use. */
  threshold: number
  /** The highest threshold that could ever be safe here. */
  ceiling: number
  /** True when the configured value had to be lowered. */
  clamped: boolean
  reason: string | null
}

/**
 * Works out the highest handoff threshold that can actually fire.
 *
 * A configured threshold is not automatically reachable. Two things can sit
 * below it, and a run where either does never hands off at all — it silently
 * degrades into the repeated in-session compaction that this tool exists to
 * avoid:
 *
 *   1. Output headroom. The model's remaining output budget has to fit in the
 *      same window, so the conversation can never occupy all of it.
 *   2. Claude Code's own auto-compaction, when it is left enabled.
 *
 * Both are read from the live session rather than assumed, because they depend
 * on the model and on settings the operator may have changed.
 */
export function effectiveHandoffThreshold(input: ThresholdInput): ThresholdResult {
  const { configured, maxTokens, maxOutputTokens, autoCompactThreshold, autoCompactEnabled } =
    input

  if (!(maxTokens > 0)) {
    return { threshold: configured, ceiling: 1, clamped: false, reason: null }
  }

  const limits: { at: number; because: string }[] = []

  if (maxOutputTokens !== null && maxOutputTokens > 0) {
    limits.push({
      at: 1 - maxOutputTokens / maxTokens,
      because:
        `the model reserves ${maxOutputTokens.toLocaleString()} tokens of the ` +
        `${maxTokens.toLocaleString()}-token window for its own output`,
    })
  }

  if (autoCompactEnabled && autoCompactThreshold !== null && autoCompactThreshold > 0) {
    limits.push({
      at: autoCompactThreshold / maxTokens,
      because:
        `Claude Code auto-compacts at ${autoCompactThreshold.toLocaleString()} tokens ` +
        `and would fire first`,
    })
  }

  if (limits.length === 0) {
    return { threshold: configured, ceiling: 1, clamped: false, reason: null }
  }

  const binding = limits.reduce((lowest, l) => (l.at < lowest.at ? l : lowest))
  const ceiling = Math.max(MIN_THRESHOLD, binding.at - HANDOFF_MARGIN)

  if (configured <= ceiling) {
    return { threshold: configured, ceiling, clamped: false, reason: null }
  }

  return {
    threshold: ceiling,
    ceiling,
    clamped: true,
    reason:
      `handoffThreshold ${(configured * 100).toFixed(0)}% is not reachable: ` +
      `${binding.because}. Using ${(ceiling * 100).toFixed(0)}% instead.`,
  }
}

/**
 * Picks the main model's output budget out of a result's per-model usage. Task
 * subagents and auxiliary calls appear alongside it, so prefer the entry for the
 * session's own model and fall back to the largest budget seen.
 */
export function pickMaxOutputTokens(
  modelUsage: Record<string, { maxOutputTokens?: number }> | undefined,
  model: string | null,
): number | null {
  if (!modelUsage) return null

  if (model) {
    const exact = modelUsage[model]?.maxOutputTokens
    if (typeof exact === 'number' && exact > 0) return exact
  }

  let best: number | null = null
  for (const usage of Object.values(modelUsage)) {
    const value = usage?.maxOutputTokens
    if (typeof value === 'number' && value > 0 && (best === null || value > best)) best = value
  }
  return best
}
