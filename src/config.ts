/**
 * Configuration, normalized once at mount.
 *
 * The knobs answer the questions an operator asks while deciding whether to keep
 * a refusal plugin mounted: *which calls does it look at* (`onlyTools`), *does it
 * have to recognise the tool to act* (`assumePersistentShell`), *what does it do
 * when it fires* (`mode`), *how do I re-enable one command it got wrong*
 * (`exempt`), *may it also repair the shell* (`arm`), and *can I ask it first*
 * (`tool`).
 *
 * The defaults are the strict-but-useful pair: inspect the `bash` tool,
 * identify it before acting, enforce, do not touch the shell. `report` exists
 * because a guard that cannot be observed before it is trusted is a guard that
 * gets unmounted after its first surprise — and this guard's rule is a
 * *measurement*, so an operator on a different bash is right to want to watch it
 * before believing it.
 *
 * @module @argszero/dsh-histexpand-guard/config
 */

/** What the guard does with a command it refuses. */
export type GuardMode = 'enforce' | 'report' | 'off'

/** The plugin configuration as a user writes it. */
export interface Config {
  /**
   * `enforce` (default) refuses the call with a reason. `report` logs the same
   * finding and lets the call run — the way to measure this guard against a shell
   * it has not been calibrated on. `off` installs nothing at all.
   */
  readonly mode?: GuardMode
  /**
   * The tool names to inspect. Defaults to `bash`, the name both bash providers
   * register; an empty list inspects every tool whose `command` argument is a
   * non-empty string.
   */
  readonly onlyTools?: readonly string[]
  /**
   * Act on a `command` argument without first resolving the tool to the
   * persistent shell's shape.
   *
   * Off by default, because the one-shot `bash` tool runs a *non-interactive*
   * shell where a `!` is ordinary text: acting on it refuses commands that work.
   * Turn it on for a deployment that renamed its shell tool or wraps it, where
   * the shape check cannot see the provider and the operator knows which one it
   * is.
   */
  readonly assumePersistentShell?: boolean
  /**
   * Also disable history expansion in the agent's live persistent shell, by
   * writing `set +o histexpand` into it once per session.
   *
   * This is the complete fix for the session and it needs no per-command
   * reasoning: with expansion off, every `!` is ordinary text and *nothing* has to
   * be refused. It is opt-in, and off by default, because it changes the state of
   * a shell the operator's agent is working in, and it cannot cover the shell's
   * first command — the shell is created by that very call, so there is nothing to
   * write into yet. Requires a `terminals` provider in the composition; silently
   * inert without one.
   */
  readonly arm?: boolean
  /**
   * Commands containing any of these substrings are never refused. The escape
   * hatch for a command whose `!` this deployment intends — a substring match
   * rather than a pattern, so that what it exempts is legible in a config file
   * without a second mental model.
   */
  readonly exempt?: readonly string[]
  /** Register the `histexpand_check` tool. */
  readonly tool?: boolean
  /**
   * Inclusive bound for the denial reason delivered to the model. 1600 is the
   * measured size of the full text — mechanism, remedies, and the excerpt of one
   * designator — with room for a second excerpt before the budget starts dropping
   * them; the excerpts are the part that is safe to lose, never the remedy.
   */
  readonly maxReasonChars?: number
  /** Inclusive bound on how many designators one denial names. */
  readonly maxReportedDesignators?: number
}

/** The configuration with every default resolved. */
export interface Settings {
  readonly mode: GuardMode
  readonly onlyTools: readonly string[]
  readonly assumePersistentShell: boolean
  readonly arm: boolean
  readonly exempt: readonly string[]
  readonly tool: boolean
  readonly maxReasonChars: number
  readonly maxReportedDesignators: number
}

/**
 * The reference defaults: the value behind every absent knob.
 *
 * Deliberately **not** exported as the plugin's `Config`. Cordis validates a
 * mounted plugin's `Config` through `Config['~standard'].validate`, and a plain
 * defaults object has no `~standard`, so exporting one there makes the mount
 * throw before `apply` runs. The entry point exports `{ name, inject, apply }`
 * with no `Config`, and these defaults arrive through `apply(ctx, config = {})`.
 */
export const defaultConfig: Required<Config> = {
  mode: 'enforce',
  onlyTools: ['bash'],
  assumePersistentShell: false,
  arm: false,
  exempt: [],
  tool: true,
  maxReasonChars: 1600,
  maxReportedDesignators: 3,
}

/** Read a boolean, falling back for anything that is not one. */
function boolean(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Read a non-negative integer, falling back when the value is absent or unusable. */
function count(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

/**
 * Read a list of non-empty strings, dropping anything else.
 *
 * The length bound is not decoration: exempt entries are matched against every
 * command the guard inspects, and an entry of unbounded length is a comparison
 * that costs more than the check it belongs to.
 * @param value - the configured list.
 * @param fallback - the default to use when the value is not a list.
 * @returns the usable entries, bounded.
 */
function strings(value: readonly string[] | undefined, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .map(entry => entry.trim().slice(0, 512))
}

/**
 * Resolve a user configuration into the settings the guard runs with.
 * @param config - the configuration as mounted, possibly empty.
 * @returns every setting, with defaults applied.
 */
export function normalizeConfig(config: Config): Settings {
  return {
    mode: config.mode === 'off' || config.mode === 'report' ? config.mode : 'enforce',
    onlyTools: strings(config.onlyTools, defaultConfig.onlyTools),
    assumePersistentShell: boolean(config.assumePersistentShell, defaultConfig.assumePersistentShell),
    arm: boolean(config.arm, defaultConfig.arm),
    exempt: strings(config.exempt, []),
    tool: boolean(config.tool, defaultConfig.tool),
    maxReasonChars: count(config.maxReasonChars, defaultConfig.maxReasonChars),
    maxReportedDesignators: count(config.maxReportedDesignators, defaultConfig.maxReportedDesignators),
  }
}
