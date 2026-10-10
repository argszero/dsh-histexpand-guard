/**
 * The verdict, and the identity check that keeps it off the wrong tool.
 *
 * ## Two tools answer to `bash`
 *
 * `@deepseek-ai/dsh-tool-bash` and `@deepseek-ai/dsh-tool-bash-persistent` both
 * register a tool whose name is literally `bash`, and only the persistent one has
 * this failure mode: the one-shot tool spawns `bash -c`, a **non-interactive**
 * shell, where `histexpand` is off and a `!` is ordinary text. Refusing a call
 * served by the one-shot tool would break commands that work — the exact harm
 * this guard exists to avoid — so the guard has to know which of the two is
 * serving the call, and must say "no" when it cannot tell.
 *
 * It can tell, and without guessing. The registry refuses a duplicate name within
 * one layer (`tool "…" is already registered`, `packages/core/tools/src/index.ts`
 * :730-733), and scoped registrations shadow globals, so for any running profile
 * the name `bash` resolves to exactly one definition. `ctx.tools.get(name, agent)`
 * returns *that* definition — the same lookup the registry itself performs before
 * dispatch. What remains is to recognise the two shapes, and they are not close:
 *
 * | resolved definition | `tool-bash` (one-shot) | `tool-bash-persistent` |
 * |---|---|---|
 * | `parameters.properties` | `description`, `command`, `timeoutMs`, `workdir`, … | `command` alone |
 * | `parameters.required` | `description`, `command` | `command` alone |
 * | `output.schema.type` | *(none — the schema is a `oneOf` of result kinds)* | `"string"` |
 *
 * A one-parameter tool that returns a bare string is the persistent shell's
 * contract. The check is structural rather than by description text, because the
 * persistent tool's `description` is deployment-configurable while its shape is
 * what its `defineTool` call fixes. It reads the **compiled** schema the registry
 * hands out, not the author's parameter map ({@link ShellShape} records why that
 * distinction cost a build).
 *
 * The check is also **fail-open**: an unfolded definition, an unreadable one, or
 * one whose shape has changed upstream is *not* the persistent shell as far as
 * this guard is concerned, so the call proceeds. A deployment that knows its
 * provider and wants the guard anyway sets `assumePersistentShell`.
 *
 * @module @argszero/dsh-histexpand-guard/policy
 */

import type { Designator } from './scan.ts'
import { designators } from './scan.ts'
import type { Settings } from './config.ts'

/** One designator this guard refuses, with the text it was read from. */
export interface Finding {
  /** The designator as read. */
  readonly designator: Designator
  /** A short excerpt around it, for the denial text. */
  readonly excerpt: string
}

/**
 * The shape facts the identity check reads off a resolved tool definition.
 *
 * Read from the **compiled** form, which is what the registry hands out:
 * `defineTool` lowers the author's parameter spec to JSON Schema before
 * registering, so a resolved definition carries
 * `parameters = { type: 'object', properties: {…}, required: […] }` rather than
 * the `{ name: { type, required } }` map the package's source shows. Reading the
 * source form here would see three properties named `type`, `properties` and
 * `required` on every tool in the deployment — measured, and the reason the first
 * build of this check refused nothing at all.
 */
export interface ShellShape {
  /** The declared parameter names, from the compiled schema's `properties`. */
  readonly parameters: readonly string[]
  /** The names the compiled schema marks required. */
  readonly required: readonly string[]
  /** The `type` of the tool's output schema, when it declares one. */
  readonly outputType: string | undefined
}

/** How much of the command to quote around a designator. */
const EXCERPT_RADIUS = 24

/**
 * Read the shape facts from a definition the registry returned.
 *
 * Everything is optional-chained and type-tested: this runs against whatever the
 * deployment mounted, so a definition that does not match the shape it is
 * expected to have must yield `undefined` rather than throw.
 * @param definition - a value from `ctx.tools.get()`.
 * @returns the shape, or `undefined` when it cannot be read.
 */
export function shellShapeOf(definition: unknown): ShellShape | undefined {
  if (typeof definition !== 'object' || definition === null) return undefined
  const schema = (definition as { parameters?: unknown }).parameters
  if (typeof schema !== 'object' || schema === null) return undefined
  const properties = (schema as { properties?: unknown }).properties
  if (typeof properties !== 'object' || properties === null) return undefined
  const required = (schema as { required?: unknown }).required
  const output = (definition as { output?: unknown }).output
  const result = typeof output === 'object' && output !== null
    ? (output as { schema?: unknown }).schema
    : undefined
  const outputType = typeof result === 'object' && result !== null
    ? (result as { type?: unknown }).type
    : undefined
  return {
    parameters: Object.keys(properties),
    required: Array.isArray(required)
      ? required.filter((entry): entry is string => typeof entry === 'string')
      : [],
    outputType: typeof outputType === 'string' ? outputType : undefined,
  }
}

/**
 * Whether a resolved definition is the persistent shell tool.
 *
 * Both halves are required. The parameter set alone would accept any future
 * one-parameter tool; the output type alone would accept any tool that returns a
 * string. Together they name the contract the persistent tool declares and the
 * one-shot tool does not.
 * @param definition - a value from `ctx.tools.get()`.
 * @returns true only for the persistent shell's shape.
 */
export function isPersistentShellTool(definition: unknown): boolean {
  const shape = shellShapeOf(definition)
  return shape !== undefined
    && shape.parameters.length === 1
    && shape.parameters[0] === 'command'
    && shape.required.length === 1
    && shape.required[0] === 'command'
    && shape.outputType === 'string'
}

/**
 * Every designator this command would hand to history expansion.
 *
 * The settings decide which commands are looked at at all, never whether a
 * reported designator is reported: exemption is a substring test and the scan is
 * mechanical, so the only ways out are "not inspected", "exempt" or "safe".
 * @param command - the command the call is about to run.
 * @param settings - the resolved configuration.
 * @returns the findings, in source order; empty for a command that will run.
 */
export function inspect(command: string, settings: Settings): Finding[] {
  const found = settings.maxReportedDesignators > 0
    ? designators(command).slice(0, settings.maxReportedDesignators)
    : []
  return found.map(designator => ({
    designator,
    excerpt: excerptAround(command, designator.index),
  }))
}

/**
 * A short window of the command around one designator.
 *
 * The excerpt exists so the model can see *which* `!` was read without the
 * denial echoing a command that may be long; it is bounded, and a `\n` in the
 * command is rendered so a multi-line command stays one line in the reason.
 * @param command - the full command.
 * @param index - the designator's index.
 * @returns the excerpt, newlines rendered.
 */
function excerptAround(command: string, index: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS)
  const end = Math.min(command.length, index + EXCERPT_RADIUS)
  const lead = start > 0 ? '…' : ''
  const trail = end < command.length ? '…' : ''
  return `${lead}${command.slice(start, end).replaceAll('\n', '\\n')}${trail}`
}
