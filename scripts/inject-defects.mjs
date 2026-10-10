/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing about the suite, and it is reported as a failure of
 * the harness rather than hidden.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first; a
 * mutation that is never written to `lib/` is a mutation the suite cannot see. A
 * mutation that does not compile is reported separately as TYPEFAIL, because it
 * never reached the suite either.
 *
 * Every arm below is a defect this plugin could plausibly have shipped: one
 * distinction it exists to make, removed one line at a time. The arms are not
 * "does the test file import the module" — each one deletes a rule the plugin
 * states in prose to its users, so a SILENT arm is a claim the package makes
 * that nothing checks.
 *
 * ```sh
 * node scripts/inject-defects.mjs                  # every arm
 * node scripts/inject-defects.mjs --filter=scan    # arms whose name matches
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  {
    // The corpus says `[ 'a' != 'b' ] && echo different` runs: `=` after the
    // designator inhibits expansion. Losing it refuses a comparison — an
    // ordinary command, refused, every time a script tests two values.
    name: 'scan: `=` no longer inhibits a designator',
    file: 'src/scan.ts',
    edits: [["export const INHIBITORS = ' =' as const", "export const INHIBITORS = ' ' as const"]],
  },
  {
    // `man bash` lists a tab as an inhibitor and this build ignores it: with a
    // tab accepted, `echo 'a' !\tthere` — which really does lose the line — is
    // allowed, which is the hang this plugin exists to prevent.
    name: 'scan: a tab is treated as an inhibitor',
    file: 'src/scan.ts',
    edits: [["export const INHIBITORS = ' =' as const", "export const INHIBITORS = ' \t=' as const"]],
  },
  {
    // `echo 'a' \!b` runs: the backslash immediately before the designator
    // suppresses it. Without the check, every escaped bang is refused.
    name: 'scan: an escaped designator is refused anyway',
    file: 'src/scan.ts',
    edits: [["    if (index > 0 && command[index - 1] === '\\\\') continue", '    if (false) continue']],
  },
  {
    // The fact the whole guard turns on: a `!` before the first single quote is
    // still inside the wrapper's quoting. Ignoring it refuses `echo "!" 'a'`,
    // which runs.
    name: 'scan: a designator before the first quote is refused',
    file: 'src/scan.ts',
    edits: [['    if (firstQuote < 0 || index < firstQuote) continue', '    if (false) continue']],
  },
  {
    // A comment stops expansion for the rest of the line, so `echo 'a' # !m`
    // runs. Ignoring the comment refuses it.
    name: 'scan: a comment the expander honours does not stop the scan',
    file: 'src/scan.ts',
    edits: [['    if (commentOpensBefore(command, index)) continue', '    if (false) continue']],
  },
  {
    // Narrower than the shell's own comment rule, because it is the expander's
    // behaviour that decides: a tab before a `#` was measured **not** to open
    // one, so accepting it allows a command that hangs.
    name: 'scan: a tab opens a comment',
    file: 'src/scan.ts',
    edits: [["export const COMMENT_PRECEDERS = ' ;&' as const", "export const COMMENT_PRECEDERS = ' \t;&' as const"]],
  },
  {
    // `quoteForBash` escapes the caller's `'` as `\'`, and that escaped quote is
    // what ends the wrapper's `$'…'` region early. Without it the port no longer
    // describes the line the persistent tool sends — and the check tool would
    // show the model a line that is not the one that runs.
    name: 'scan: the wrapper does not escape the caller\'s quote',
    file: 'src/scan.ts',
    edits: [['.replaceAll("\'", "\\\\\'")', '.replaceAll("\'", "\'")']],
  },
  {
    // Measured, and the first build of this check got it wrong: the registry
    // hands out the **compiled** JSON Schema, so reading the schema object as if
    // it were the author's `{ name: … }` map sees `type`/`properties`/`required`
    // on every tool — three parameters, never the persistent shape, and a guard
    // that refuses nothing at all.
    name: 'policy: the compiled property map is read as the parameter map',
    file: 'src/policy.ts',
    edits: [['    parameters: Object.keys(properties),', '    parameters: Object.keys(schema),']],
  },
  {
    // The one-shot `bash` tool declares more than one parameter. Dropping the
    // clause lets a tool that spawns a **non-interactive** shell be refused —
    // the exact harm this plugin exists to avoid.
    name: 'policy: any tool with a `command` parameter is the persistent shell',
    file: 'src/policy.ts',
    edits: [['    && shape.parameters.length === 1\n    && shape.parameters[0] === \'command\'\n', '']],
  },
  {
    // A tool that takes `command` but does not require it is not the persistent
    // contract; the contract is what the check is for.
    name: 'policy: an optional `command` still names the persistent shell',
    file: 'src/policy.ts',
    edits: [['    && shape.required.length === 1\n    && shape.required[0] === \'command\'\n', '']],
  },
  {
    // A bare-string result is the persistent tool's output contract; the one-shot
    // tool returns a `oneOf` of result kinds.
    name: 'policy: a tool that does not return a string is the persistent shell',
    file: 'src/policy.ts',
    edits: [["    && shape.outputType === 'string'\n", '']],
  },
  {
    // The bound exists so one command with many designators cannot produce a
    // denial of unbounded size.
    name: 'policy: every designator is reported regardless of the bound',
    file: 'src/policy.ts',
    edits: [['  const found = settings.maxReportedDesignators > 0\n    ? designators(command).slice(0, settings.maxReportedDesignators)\n    : []',
      '  const found = designators(command)']],
  },
  {
    // `exempt` is the escape hatch for a command whose `!` this deployment
    // intends; closing it removes the only way to re-enable one wrong refusal.
    name: 'index: an exempt command is refused anyway',
    file: 'src/index.ts',
    edits: [['  if (isExempt(command, settings)) return undefined', '  if (false) return undefined']],
  },
  {
    // Only the tools named in `onlyTools` are inspected; ignoring the list makes
    // the guard act on tools it was never pointed at.
    name: 'index: `onlyTools` is ignored',
    file: 'src/index.ts',
    edits: [['  if (settings.onlyTools.length > 0 && !settings.onlyTools.includes(exec.name)) return undefined', '  if (false) return undefined']],
  },
  {
    // An empty list is documented as "inspect every tool with a command
    // argument" — not as "inspect nothing".
    name: 'index: an empty `onlyTools` inspects nothing',
    file: 'src/index.ts',
    edits: [['  if (settings.onlyTools.length > 0 && !settings.onlyTools.includes(exec.name)) return undefined',
      '  if (!settings.onlyTools.includes(exec.name)) return undefined']],
  },
  {
    // `report` exists so the guard can be measured against a shell it was not
    // calibrated on; a report that refuses has taken away the only way to
    // measure it.
    name: 'index: report mode refuses anyway',
    file: 'src/index.ts',
    edits: [['        ctx.logger.warn(`histexpand-guard (report): would refuse ${exec.name}: ${reason}`)\n        return next()\n',
      '        ctx.logger.warn(`histexpand-guard (report): would refuse ${exec.name}: ${reason}`)\n']],
  },
  {
    name: 'index: `off` mode installs the guard anyway',
    file: 'src/index.ts',
    edits: [["  if (settings.mode === 'off') return\n", '']],
  },
  {
    name: 'index: the inspection tool is registered even when it is turned off',
    file: 'src/index.ts',
    edits: [['  const tool = settings.tool ? ctx.tools.register(checkTool(ctx, settings)) : undefined',
      '  const tool = ctx.tools.register(checkTool(ctx, settings))']],
  },
  {
    // The identity check is what keeps the refusal off the one-shot tool. This
    // is the arm that turns the whole "why it will not refuse the wrong tool"
    // section of the README into something measured.
    name: 'index: the persistent-shell identity is not required',
    file: 'src/index.ts',
    edits: [['  if (command === undefined || !servesPersistentShell(ctx, exec, settings)) return next()',
      '  if (command === undefined) return next()']],
  },
  {
    // With the shell armed, expansion is off and nothing needs refusing. A
    // guard that refuses anyway has made `arm` pointless.
    name: 'index: arming the shell does not let the command through',
    file: 'src/index.ts',
    edits: [["        const covered = await armShells(ctx, exec, armed, failed('arming the persistent shell'))\n        if (covered) return next()",
      "        await armShells(ctx, exec, armed, failed('arming the persistent shell'))"]],
  },
  {
    name: 'config: a mode that is not `off` is enforcing',
    file: 'src/config.ts',
    edits: [["    mode: config.mode === 'off' || config.mode === 'report' ? config.mode : 'enforce',", "    mode: config.mode === 'off' ? 'off' : 'enforce',"]],
  },
  {
    name: 'config: the exempt list is ignored',
    file: 'src/config.ts',
    edits: [['    exempt: strings(config.exempt, []),', '    exempt: [],']],
  },
  {
    name: 'config: the inspection tool cannot be turned off',
    file: 'src/config.ts',
    edits: [['    tool: boolean(config.tool, defaultConfig.tool),', '    tool: true,']],
  },
  {
    name: 'config: arming cannot be requested',
    file: 'src/config.ts',
    edits: [['    arm: boolean(config.arm, defaultConfig.arm),', '    arm: false,']],
  },
  {
    // The operator who renamed or wrapped the shell tool is the one case the
    // structural check cannot answer; this is their switch.
    name: 'config: `assumePersistentShell` is ignored',
    file: 'src/config.ts',
    edits: [['    assumePersistentShell: boolean(config.assumePersistentShell, defaultConfig.assumePersistentShell),',
      '    assumePersistentShell: false,']],
  },
  {
    name: 'config: the designator bound is ignored',
    file: 'src/config.ts',
    edits: [['    maxReportedDesignators: count(config.maxReportedDesignators, defaultConfig.maxReportedDesignators),',
      '    maxReportedDesignators: defaultConfig.maxReportedDesignators,']],
  },
  {
    // A model that cannot tell whether the command ran will often assume it did.
    name: 'advice: the closing sentence is dropped',
    file: 'src/advice.ts',
    edits: [["const TRAILER = 'Nothing was executed.'", "const TRAILER = ''"]],
  },
  {
    // The order of the budget: the mechanism and the remedies are never dropped,
    // the excerpts are dropped whole. Swapping them spends the budget on the
    // quote and cuts the sentence that names the fix.
    name: 'advice: the excerpts are preferred over the mechanism',
    file: 'src/advice.ts',
    edits: [['  for (const body of [withExcerpts, withoutExcerpts]) {', '  for (const body of [withoutExcerpts, withExcerpts]) {']],
  },
  {
    // A `maxReasonChars` that is not applied is not a bound: the denial grows
    // with the command, inside an error result the model has to read.
    name: 'advice: the bound is not applied to the body',
    file: 'src/advice.ts',
    edits: [['    if (whole.length <= maxChars) return whole', '    if (whole.length <= Number.MAX_SAFE_INTEGER) return whole']],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: an arm that removes a guard from a path the
 * plugin observes can leave a rejected promise unhandled, and a mutant that
 * never terminates is a mutant the suite cannot report on. It is killed here
 * and counted as caught, which is what it is — the suite never reaches its
 * assertions because the code under test never returns.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant. Rebuilt
// once here so the tree is consistent whether a human runs this or CI does.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 ? 0 : 1
