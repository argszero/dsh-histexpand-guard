/**
 * A `!` in a `bash` call can cost the session five minutes.
 *
 * The persistent bash tool writes each command into an *interactive* shell as a
 * single `$'…'` line, and an interactive bash expands history (`!…`) before it
 * parses anything. When the expander meets a `!` it cannot resolve it prints
 * `bash: !word: event not found` and discards **the whole line** — the command,
 * the exit-status capture, and the tool's own end-of-command marker. The tool
 * polls a scrollback that will never contain that marker until its command
 * deadline fires: `timeoutMs`, 300 seconds by default. The command did not run,
 * nothing says why, and the model learns only that the call "timed out".
 *
 * Reports of it reach the harness as a timeout mystery — a heredoc whose shebang
 * contains `!` (discussion #9240, #5046), a `git commit -m '…!'` — because the
 * commands look entirely ordinary. They are: `echo "hi!"` runs and `echo 'hi!'`
 * hangs, and the difference is not in the command's meaning but in whether a
 * single quote precedes the `!`, which is what stops the wrapper's quoting from
 * protecting the rest of the line (`src/scan.ts` states the measurement in full).
 *
 * ## What this plugin does
 *
 * At `tools/pre-execute` — the documented point for deciding *before* a tool runs
 * — it refuses the call, with a reason that names the designator it read, the
 * mechanism, and the rewrites that work. The command never reaches the shell, so
 * the cost is one turn instead of one timeout.
 *
 * It refuses **only** that. It does not judge commands, does not look at anything
 * but the `command` argument, does not touch the shell unless asked (`arm`), and
 * does not act on a tool it cannot identify: `tool-bash` and
 * `tool-bash-persistent` both register a tool named `bash`, and only the
 * persistent one runs an interactive shell, so {@link isPersistentShellTool} reads
 * the definition the registry will dispatch to and stays out of the one-shot
 * tool's way (`src/policy.ts` explains the check). A scan that throws is logged
 * and the call proceeds — a guard whose own bug refuses every call in a deployment
 * is a worse failure than the one it prevents.
 *
 * ## What it is not
 *
 * It is not the fix. The fix is one line in the persistent shell's initialization,
 * next to the `stty -echo` the tool already sends:
 *
 * ```sh
 * set +o histexpand
 * ```
 *
 * That removes the hazard for every command, including the ones no rule can
 * classify, and it is the change this plugin exists to make unnecessary. A plugin
 * cannot make it — the shell is created inside the tool's own body — so the guard
 * refuses the shape it can prove, and `arm: true` writes the same line into the
 * agent's live shell when an operator wants the complete fix without patching
 * upstream.
 *
 * @module @argszero/dsh-histexpand-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { defaultConfig, normalizeConfig } from './config.ts'
import type { Config, Settings } from './config.ts'
import { inspect, isPersistentShellTool, shellShapeOf } from './policy.ts'
import { renderDenial } from './advice.ts'
import { wrappedLiteral } from './scan.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'histexpand-guard'

/**
 * The service this plugin reads. `tools` is required twice over: the listener is
 * dispatched through the tool registry's own waterfall, and the optional
 * inspection tool is registered on the same registry. The `terminals` service is
 * read through `ctx.get` instead — only `arm` needs it, and requiring it would
 * refuse to load in every composition that has no PTY.
 */
export const inject = ['tools']

export type { Config, Settings, GuardMode } from './config.ts'
export { defaultConfig, normalizeConfig } from './config.ts'
export { inspect, isPersistentShellTool, shellShapeOf } from './policy.ts'
export type { Finding, ShellShape } from './policy.ts'
export { designators, hasDesignator, wrappedLiteral, INHIBITORS, COMMENT_PRECEDERS } from './scan.ts'
export type { Designator } from './scan.ts'
export { renderDenial } from './advice.ts'

/** The command line a call is about to run, when it is one this guard inspects. */
function commandOf(exec: ToolExecution, settings: Settings): string | undefined {
  if (settings.onlyTools.length > 0 && !settings.onlyTools.includes(exec.name)) return undefined
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return undefined
  const command = (args as { command?: unknown }).command
  return typeof command === 'string' && command.trim() !== '' ? command : undefined
}

/** Whether the operator exempted this command from the guard. */
function isExempt(command: string, settings: Settings): boolean {
  return settings.exempt.some(entry => command.includes(entry))
}

/**
 * Whether the call would be served by the persistent shell.
 *
 * Reads the definition the registry resolves for this call — the same lookup it
 * performs before dispatch — so a scoped registration that shadows the global
 * `bash` is answered for the scope that will actually run it.
 * @param ctx - the plugin context, carrying the tool registry.
 * @param exec - the pending call.
 * @param settings - the resolved configuration.
 * @returns true when the guard may act on this call.
 */
function servesPersistentShell(ctx: Context, exec: ToolExecution, settings: Settings): boolean {
  if (settings.assumePersistentShell) return true
  return isPersistentShellTool(ctx.tools.get(exec.name, exec.agent))
}

/**
 * The minimum of the PTY service `arm` needs.
 *
 * Declared structurally rather than imported so this plugin keeps one peer
 * dependency: a deployment without a `terminals` provider gets a guard that only
 * refuses, not one that fails to load.
 */
interface TerminalsLike {
  list(owner: object): readonly { readonly sessionId: string }[]
  startSend(
    owner: object,
    id: string,
    request: { readonly text: string; readonly submit: boolean; readonly signal: AbortSignal },
  ): { readonly done: Promise<unknown> }
}

/** Narrow the value `ctx.get('terminals')` returned, without trusting it. */
function asTerminals(value: unknown): TerminalsLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { list?: unknown; startSend?: unknown }
  if (typeof candidate.list !== 'function' || typeof candidate.startSend !== 'function') return undefined
  return value as TerminalsLike
}

/** The line that removes the hazard for a whole shell. */
export const DISARM_COMMAND = 'set +o histexpand'

/**
 * Disable history expansion in every live shell this owner owns.
 *
 * Per-session and idempotent: a session id is armed once. A failure (a shell that
 * already has a send in flight, a session that exited between the list and the
 * send) is logged and otherwise ignored — arming is an optimization over the
 * refusal, never a precondition for it.
 * @param ctx - the plugin context.
 * @param exec - the pending call, whose owner and signal the arming send uses.
 * @param armed - session ids already armed by this mount.
 * @param onError - called with anything the arming send threw.
 * @returns true when the owner's live shells are known to be armed.
 */
async function armShells(
  ctx: Context,
  exec: ToolExecution,
  armed: Set<string>,
  onError: (error: unknown) => void,
): Promise<boolean> {
  const owner = exec.agent
  if (owner === undefined) return false
  const terminals = asTerminals(ctx.get('terminals'))
  if (terminals === undefined) return false
  let sessions
  try {
    sessions = terminals.list(owner)
  } catch (error: unknown) {
    onError(error)
    return false
  }
  if (sessions.length === 0) return false
  let complete = true
  for (const session of sessions) {
    if (armed.has(session.sessionId)) continue
    try {
      await terminals.startSend(owner, session.sessionId, {
        text: DISARM_COMMAND,
        submit: true,
        signal: exec.signal,
      }).done
      armed.add(session.sessionId)
    } catch (error: unknown) {
      complete = false
      onError(error)
    }
  }
  return complete
}

/**
 * The denial for a call, or `undefined` when it is allowed.
 *
 * Every path out of this function is deliberate. A call the guard does not
 * inspect is allowed; an exempt command is allowed; a scan that throws is logged
 * and allowed; a shell whose history expansion this mount already turned off is
 * allowed without prediction, because nothing is left to predict.
 * @param exec - the pending call.
 * @param settings - the resolved configuration.
 * @param onError - called with anything the scan threw.
 * @returns the reason to refuse, or `undefined`.
 */
function denyReason(
  exec: ToolExecution,
  settings: Settings,
  onError: (error: unknown) => void,
): string | undefined {
  const command = commandOf(exec, settings)
  if (command === undefined) return undefined
  if (isExempt(command, settings)) return undefined
  try {
    const findings = inspect(command, settings)
    if (findings.length === 0) return undefined
    return renderDenial(findings, settings.maxReasonChars)
  } catch (error: unknown) {
    onError(error)
    return undefined
  }
}

/**
 * The read-only inspection tool.
 *
 * It answers the question the rule is otherwise only visible through a refusal,
 * which is what makes `mode: 'report'` usable without guessing: the same decision,
 * on demand, without running anything and without needing a shell to hang.
 * @param ctx - the plugin context, for the tool-identity lookup.
 * @param settings - the resolved configuration.
 * @returns the tool definition.
 */
function checkTool(ctx: Context, settings: Settings) {
  return defineTool({
    name: 'histexpand_check',
    description: 'Report whether histexpand-guard would refuse a bash command, and why, without running it. '
      + 'Use it before a command that contains a `!` — a shebang inside a heredoc, a commit message ending '
      + 'in `!` — to find out whether the persistent shell would drop the line.',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'The bash command to check. It is not executed.',
      },
      tool: {
        type: 'string',
        description: 'The tool that would run it; defaults to `bash`.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const command = typeof args.command === 'string' ? args.command : ''
      if (command.trim() === '') {
        return 'histexpand_check: the command argument is empty; nothing to check.'
      }
      const toolName = typeof args.tool === 'string' && args.tool.trim() !== ''
        ? args.tool.trim()
        : settings.onlyTools[0] ?? 'bash'
      const definition = ctx.tools.get(toolName)
      const shape = shellShapeOf(definition)
      const identified = settings.assumePersistentShell || isPersistentShellTool(definition)
      const identity = shape === undefined
        ? `tool "${toolName}" is not registered in the global scope, so the guard cannot identify its provider`
        : `tool "${toolName}" declares parameters [${shape.parameters.join(', ')}] and output type `
          + `${shape.outputType ?? '(none)'} — ${identified ? 'the persistent shell shape' : 'NOT the persistent shell shape'}`
      const header = `${identity}.\n${settings.assumePersistentShell
        ? 'assumePersistentShell is on, so the guard acts on the command regardless.'
        : (identified ? '' : 'The guard would not act on this call.')}\n`
      const literal = `\nThe wrapper sends this as one physical line:\n  ${wrappedLiteral(command)}\n`
      if (isExempt(command, settings)) {
        return `${header}\nALLOWED (exempt): the command matches the exempt list, so the guard will not refuse it.${literal}`
      }
      const findings = inspect(command, settings)
      if (findings.length === 0) {
        return `${header}\nALLOWED: no history-expansion designator this guard can prove would reach the shell.${literal}`
      }
      return `${header}\nREFUSED (${settings.mode === 'report' ? 'report mode: logged, not refused' : 'enforce mode'}):\n\n`
        + renderDenial(findings, settings.maxReasonChars)
        + literal
    },
  })
}

/**
 * Mount the guard.
 *
 * Both mount spellings are supported: `ctx.plugin(moduleNamespace)` has Cordis
 * fill the exported `Config` defaults, while `ctx.plugin({ name, inject, apply })`
 * passes `undefined` — so the default has to be here, not only in the schema.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  if (settings.mode === 'off') return

  ctx.effect(() => {
    const armed = new Set<string>()
    const disposed = ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const failed = (subject: string) => (error: unknown) => {
        ctx.logger.warn(`histexpand-guard: ${subject} failed, allowing the call: ${String(error)}`)
      }
      const command = commandOf(exec, settings)
      if (command === undefined || !servesPersistentShell(ctx, exec, settings)) return next()
      if (settings.arm) {
        const covered = await armShells(ctx, exec, armed, failed('arming the persistent shell'))
        if (covered) return next()
      }
      const reason = denyReason(exec, settings, failed('scan'))
      if (reason === undefined) return next()
      if (settings.mode === 'report') {
        ctx.logger.warn(`histexpand-guard (report): would refuse ${exec.name}: ${reason}`)
        return next()
      }
      ctx.logger.warn(`histexpand-guard: refused ${exec.name}: history expansion would drop the line`)
      return { kind: 'deny', reason, info: { name: 'HistoryExpansionError', code: 'HISTEXPAND_DESIGNATOR' } }
    }, { prepend: true })

    const tool = settings.tool ? ctx.tools.register(checkTool(ctx, settings)) : undefined
    return () => {
      disposed()
      tool?.()
    }
  }, 'histexpand-guard: refuse a bash command the persistent shell would drop to history expansion')
}

export default { name, inject, apply, Config: defaultConfig }
