/**
 * The integration harness: a REAL cordis context, the REAL `ToolRuntime` from
 * `@deepseek-ai/dsh-tools`, and REAL tool definitions registered on it.
 *
 * Nothing about the seam is simulated. The plugin listens on
 * `tools/pre-execute`; this harness dispatches through `ctx.tools.execute()`,
 * which is the registry's own public entry point, so the pipeline under test —
 * the waterfall, the `deny` short-circuit, the normalized error result — is the
 * shipped one. The only fabricated article is the tool *body*, which records that
 * it ran and returns a canned value; that is what lets a test assert the property
 * the whole plugin rests on, that a refused call never reaches the body.
 *
 * The two shell tools are registered with the shapes the shipped packages really
 * declare (`persistent` and `oneshot`, below), because the guard's identity check
 * reads exactly those shapes. Registering only one of them is also what the
 * registry allows: two tools named `bash` in one layer is a registration error, so
 * every world here has one `bash`.
 *
 * `test/guard.spec.mjs` also runs hazardous commands with the plugin absent, so
 * every refusal is measured against the same command *running* when nothing is
 * mounted. A control arm is what turns "the result was an error" into "the plugin
 * caused the error".
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'

/** The neutral signal every fabricated call carries. */
export const SIGNAL = new AbortController().signal

/**
 * The shapes a tool that answers to `bash` can declare.
 *
 * `persistent` is `@deepseek-ai/dsh-tool-bash-persistent`: one required
 * parameter, a string result — the only shape with this failure mode.
 * `oneshot` is `@deepseek-ai/dsh-tool-bash`: a required `description` among its
 * parameters and an object result.
 *
 * The other three are what the identity check has to reject on **one** condition
 * each, so that removing any one of its three clauses is a defect the suite can
 * see rather than a claim nothing measures:
 *
 * - `stringy` — the string result and a second parameter, as a wrapper tool
 *   taking an extra flag would declare it: caught by the parameter count alone.
 * - `silent` — the one required `command` and an object result: caught by the
 *   output type alone.
 * - `optional` — the one `command` parameter, string result, not required:
 *   caught by the required-name clause alone.
 *
 * Each carries a `sample` the fabricated body returns, because the registry
 * validates a tool's output against its own schema and a body that answers with
 * the wrong shape fails the call for a reason that has nothing to do with the
 * guard.
 */
export const SHELL_SHAPES = {
  persistent: {
    parameters: { command: { type: 'string', required: true } },
    output: { type: 'string' },
    sample: 'ok',
  },
  oneshot: {
    parameters: {
      description: { type: 'string', required: true },
      command: { type: 'string', required: true },
      timeoutMs: { type: 'number' },
      workdir: { type: 'string' },
    },
    // The shipped one-shot tool returns a `oneOf` of result kinds, with no
    // top-level `type` — that absence is half of what tells the two apart. The
    // `additionalProperties` flags are not decoration: the registry's schema
    // compiler rejects an object schema that leaves them implicit.
    output: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: { kind: { type: 'string', required: true, const: 'foreground' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: { kind: { type: 'string', required: true, const: 'promoted' } },
        },
      ],
    },
    sample: { kind: 'foreground' },
  },
  stringy: {
    parameters: {
      command: { type: 'string', required: true },
      timeoutMs: { type: 'number' },
    },
    output: { type: 'string' },
    sample: 'ok',
  },
  silent: {
    parameters: { command: { type: 'string', required: true } },
    output: {
      type: 'object',
      additionalProperties: true,
      properties: { kind: { type: 'string', required: true } },
    },
    sample: { kind: 'foreground' },
  },
  optional: {
    parameters: { command: { type: 'string' } },
    output: { type: 'string' },
    sample: 'ok',
  },
}

/** A fake PTY service that records every send, for the `arm` tests. */
export function fakeTerminals(sessions = [{ sessionId: 'pty-1' }]) {
  const sent = []
  const failures = new Map()
  const service = {
    sent,
    list: owner => (owner === undefined ? [] : sessions),
    startSend: (owner, id, request) => {
      const failure = failures.get(id)
      sent.push({ owner, id, text: request.text, submit: request.submit })
      return failure === undefined
        ? { done: Promise.resolve({ viewport: '' }) }
        : { done: Promise.reject(failure) }
    },
    sessions,
    failWith: (id, error) => failures.set(id, error),
  }
  return service
}

/**
 * Mount a real context with a real tool registry, and by default this plugin.
 *
 * @param spec - `plugin: false` mounts everything except this plugin (the control
 *   arm); `config` is the plugin's configuration; `shellShape` selects which bash
 *   shape is registered; `terminals` installs a fake PTY service; `agent` sets the
 *   owning agent on every call.
 * @returns the context, the record of every body that ran, and the captured log.
 */
export async function world(spec = {}) {
  const ctx = new Context({})
  const ran = []
  const logged = []
  ctx.logger.exporter({ levels: { default: 2 }, export: message => { logged.push(message) } })

  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  const shape = SHELL_SHAPES[spec.shellShape ?? 'persistent']
  const toolName = spec.toolName ?? 'bash'
  ctx.tools.register(defineTool({
    name: toolName,
    description: 'run a bash command',
    parameters: shape.parameters,
    output: {
      schema: shape.output,
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      ran.push({ command: args.command })
      return shape.sample
    },
  }))

  const terminals = spec.terminals ?? undefined
  if (terminals !== undefined) ctx.provide('terminals', terminals)

  if (spec.plugin !== false) {
    // `plugin` is this module's namespace; a loader entry mounts its **default**
    // export (`exports.default ?? exports`), and the two differ by the `Config` key.
    // `plugin: 'default'` mounts the object a profile entry actually reaches — see
    // test/mount.spec.mjs for the defect that difference hides.
    await ctx.plugin(spec.plugin === 'default' ? plugin.default : plugin, spec.config ?? {})
  }
  return { ctx, ran, logged, terminals, toolName }
}

/** Whether this world can carry an owning agent. */
const AGENT = { id: 'agent-1' }

/**
 * Run one command through the real registry.
 * @param harness - a harness from {@link world}.
 * @param command - the command line.
 * @param options - `toolName`, and `agent` to attach an owning agent.
 * @returns the normalized tool result.
 */
export function run(harness, command, options = {}) {
  return harness.ctx.tools.execute({
    signal: SIGNAL,
    callId: ToolCallId(`call-${Math.random().toString(36).slice(2)}`),
    name: options.toolName ?? harness.toolName,
    arguments: { command, description: 'test' },
    ...options.agent === true ? { agent: AGENT } : {},
  })
}

/** The text of a result's first content block. */
export function resultText(result) {
  return result.content?.map(block => (block.type === 'text' ? block.text : '')).join('') ?? ''
}

/** Whether a result is the failure the registry materializes for a denial. */
export function isFailure(result) {
  return result.isError === true
}

/** The captured log as one string. */
export function logText(logged) {
  return logged
    .map(message => message.args.map(argument => String(argument)).join(' '))
    .join('\n')
}
