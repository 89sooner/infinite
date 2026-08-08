/**
 * Smallest headroom worth keeping, used when a run has not yet seen a full turn
 * of growth. Only has to cover the handoff turn itself, whose response is short
 * because the document goes to a file.
 */
export const HANDOFF_MARGIN = 0.03

/**
 * How much of the window a turn is assumed to add before the run has measured
 * it. A turn that reads a file in slices can add fifteen points at once, and the
 * threshold is only checked between turns, so assuming less than this risks
 * sailing past the ceiling with no chance to hand off.
 */
export const ASSUMED_TURN_GROWTH = 0.15

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
  /**
   * Largest share of the window a single turn has been seen to add, as measured
   * during this run. Null before a turn-to-turn delta exists.
   */
  turnGrowth: number | null
}

export type ThresholdResult = {
  /** The threshold to actually use. */
  threshold: number
  /** The point at which the session runs out of usable window. */
  ceiling: number
  /** Room kept below the ceiling so one more turn cannot overshoot it. */
  headroom: number
  /** True when the configured value had to be lowered. */
  clamped: boolean
  /**
   * True when the clamp rests only on the assumed turn size, so a measurement
   * may lift it again. Such a clamp is worth applying but not worth alarming
   * about — on a roomy window the assumption is usually pessimistic.
   */
  provisional: boolean
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
 *
 * The ceiling alone is not enough. Usage is only sampled between turns, and one
 * turn can add fifteen points of window, so a threshold sitting just under the
 * ceiling gets jumped clean over: the turn that would have triggered the handoff
 * instead runs out of context. The threshold therefore sits a full turn's growth
 * below the ceiling, measured from the run itself once there is something to
 * measure.
 */
export function effectiveHandoffThreshold(input: ThresholdInput): ThresholdResult {
  const {
    configured,
    maxTokens,
    maxOutputTokens,
    autoCompactThreshold,
    autoCompactEnabled,
    turnGrowth,
  } = input

  const headroom = Math.max(HANDOFF_MARGIN, turnGrowth ?? ASSUMED_TURN_GROWTH)

  if (!(maxTokens > 0)) {
    return {
      threshold: configured,
      ceiling: 1,
      headroom,
      clamped: false,
      provisional: false,
      reason: null,
    }
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
    return {
      threshold: configured,
      ceiling: 1,
      headroom,
      clamped: false,
      provisional: false,
      reason: null,
    }
  }

  const binding = limits.reduce((lowest, l) => (l.at < lowest.at ? l : lowest))
  const ceiling = binding.at
  const safe = Math.max(MIN_THRESHOLD, ceiling - headroom)

  if (configured <= safe) {
    return { threshold: configured, ceiling, headroom, clamped: false, provisional: false, reason: null }
  }

  const measured = turnGrowth !== null
  // Would this have been clamped even without the guess about turn size? If not,
  // the guess is doing the work and a measurement may well undo it.
  const provisional = !measured && configured <= ceiling - HANDOFF_MARGIN

  const reason = provisional
    ? `handoffThreshold ${pct(configured)} may not be reachable: ${binding.because}, ` +
      `leaving a ${pct(ceiling)} ceiling. Until a turn has been measured, one is assumed ` +
      `to add ${pct(headroom)} of the window, so the threshold starts at ${pct(safe)} and ` +
      `rises again if turns turn out smaller.`
    : `handoffThreshold ${pct(configured)} is not reachable: ${binding.because}, ` +
      `leaving a ${pct(ceiling)} ceiling, and a single turn ` +
      `${measured ? 'has been seen to add' : 'is assumed to add'} ${pct(headroom)} of the ` +
      `window — a threshold nearer the ceiling would be jumped over rather than hit. ` +
      `Using ${pct(safe)} instead.`

  return { threshold: safe, ceiling, headroom, clamped: true, provisional, reason }
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`
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
