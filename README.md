# @argszero/dsh-histexpand-guard

Refuses a `bash` call before it runs when the **persistent** shell would drop the
line to history expansion — the command never executes, nothing is asked of the
operator, and the model is told why instead of waiting five minutes for a
deadline.

It refuses exactly that, and nothing else:

- a command with a single quote and a `!` after it — the point where the
  wrapper's `$'…'` quoting stops protecting the command text;
- where that `!` is one an interactive bash would act on: not preceded by a
  backslash, not followed by a space or `=`, and not inside a comment the
  *expander* honours (a preceding space, `;` or `&`).

Both are facts about the text. The rule was **measured**, not reasoned:
`scripts/calibrate-history-expansion.py` builds the exact line the wrapper
builds, feeds it to a real interactive bash, and compares the verdict —
**45/45** agreement on the pinned corpus at the time of writing.

## The problem

The persistent bash tool does not run a command the way a script would
([#9240](https://github.com/deepseek-ai/deepseek-harness/discussions/9240),
[#5046](https://github.com/deepseek-ai/deepseek-harness/discussions/5046)).
It renders the command into **one physical line** of an *interactive* shell and
writes that line to the shell's stdin:

```sh
printf '%s\n' $'<START>'; eval -- $'<command>'; st=$?; printf '%s%s\n' $'<END>' "$st"
```

History expansion runs on that line before bash parses anything, and an
interactive shell has `histexpand` on by default. When the expander reaches a
`!` it cannot resolve it prints `bash: !word: event not found` and discards
**the whole line** — the `eval`, the exit-status capture and the closing
`printf` included. The tool then polls a scrollback that will never contain its
end marker until `timeoutMs` expires: **300 seconds**, the shipped default.

So a command like this one hangs the session for five minutes and produces no
output and no reason:

```sh
cat > x.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
EOF
```

It looks ordinary, and that is the point — the reports arrive as timeout
mysteries. Two measurements show the shape of it:

```sh
echo "hi!"     # runs
echo 'hi!'     # hangs
```

The difference is not in the command's meaning. The wrapper renders a caller's
`'` as `\'` inside its `$'…'` region, and the expander reads that as the end of
the region *without honouring the backslash* — so from the first single quote
onward the command text is no longer inside the wrapper's quoting, and a `!`
after it reaches history expansion. A `!` **before** any single quote is still
protected, which is why `echo "!" 'a'` runs.

## The fix is upstream, and it is one line

Next to the `stty -echo` the persistent tool already sends at shell
initialization:

```sh
set +o histexpand
```

That removes the hazard for *every* command, including the shapes no rule can
classify, and it is the change this plugin exists to make unnecessary. A plugin
cannot make it — the shell is created inside the tool's own body — so this
package does the two things a plugin can do: it refuses the shape it can prove,
and `arm: true` writes that same line into the agent's live shell for an
operator who wants the complete fix without patching upstream.

## Install

```sh
npm install @argszero/dsh-histexpand-guard@0.1.0
```

The package ships a bundle patch (`dsh.bundle.patch: ./cordis.patch.yml`), so a
deployment that follows the harness's bundle convention gets it by adding one
entry:

```yaml
- insert:
    - id: histexpand-guard
      name: '@argszero/dsh-histexpand-guard'
```

Mounting it directly works the same way and takes the same config:

```ts
import guard from '@argszero/dsh-histexpand-guard'

ctx.plugin(guard, { mode: 'report' })
```

## Configuration

| key | default | meaning |
|---|---|---|
| `mode` | `'enforce'` | `enforce` refuses the call; `report` logs the same finding and lets the call run — the way to measure this guard against a shell it was not calibrated on; `off` installs nothing at all |
| `onlyTools` | `['bash']` | the tool names to inspect. An empty list inspects every tool with a non-empty `command` argument |
| `assumePersistentShell` | `false` | act on a `command` argument without first resolving the tool to the persistent shell's shape. For a deployment that renamed or wrapped its shell tool |
| `arm` | `false` | also write `set +o histexpand` into the agent's live persistent shell, once per session. Requires a `terminals` provider; silently inert without one |
| `exempt` | `[]` | commands containing any of these substrings are never refused |
| `tool` | `true` | register the `histexpand_check` tool |
| `maxReasonChars` | `1600` | inclusive bound for the denial text |
| `maxReportedDesignators` | `3` | inclusive bound on how many designators one denial names |

`report` is not decoration. This guard's rule is a *measurement* against a
particular bash, so an operator on a different build is right to want to watch
it before believing it:

```ts
ctx.plugin(guard, { mode: 'report' })
```

## The check tool

`histexpand_check` answers the same question on demand, without running
anything — the way to know a command is safe *before* the shell tells you it is
not:

```
histexpand_check({ command: "cat > x.sh <<'EOF'\n#!/usr/bin/env bash\nEOF" })
```

It reports whether the guard would refuse, which tool it resolved and therefore
whether it would act at all, and the exact `$'…'` line the wrapper would send.

## Why it will not refuse the wrong tool

`@deepseek-ai/dsh-tool-bash` and `@deepseek-ai/dsh-tool-bash-persistent` both
register a tool named `bash`, and only the persistent one has this failure mode:
the one-shot tool spawns `bash -c`, a **non-interactive** shell, where
`histexpand` is off and a `!` is ordinary text. Refusing a call served by the
one-shot tool would break commands that work — the exact harm this guard exists
to avoid.

The registry refuses a duplicate name within one layer, and scoped
registrations shadow globals, so for any running profile the name `bash`
resolves to exactly one definition. The guard reads that definition with
`ctx.tools.get(name, agent)` — the same lookup the registry performs before
dispatch — and requires the persistent tool's compiled shape:

| resolved definition | `tool-bash` (one-shot) | `tool-bash-persistent` |
|---|---|---|
| `parameters.properties` | `description`, `command`, `timeoutMs`, `workdir`, … | `command` alone |
| `parameters.required` | `description`, `command` | `command` alone |
| `output.schema.type` | *(none — a `oneOf` of result kinds)* | `"string"` |

The check is structural, not by description text, because the persistent tool's
`description` is deployment-configurable while its shape is what its
`defineTool` call fixes. It reads the **compiled** JSON Schema the registry
hands out, not the parameter map the package's source shows. A deployment that
knows its provider sets `assumePersistentShell`.

## What it deliberately does not do

- It does not judge commands, and it does not look at anything but the
  `command` argument.
- It does not act on a tool it cannot identify: an unresolvable definition, an
  unreadable one, or one whose shape changed upstream is *not* the persistent
  shell as far as this guard is concerned.
- It does not touch the shell unless `arm` is set.
- It fails **open**: a scan that throws is logged and the call proceeds. A guard
  whose own bug refuses every call in a deployment is a worse failure than the
  one it prevents.

Every deliberate looseness in the scan leans the same way: toward *not*
reporting a designator. A missed designator leaves the deployment exactly as it
is today; a spurious one refuses a command that works.

## Compatibility

Verified against the `0.1.7-rc.2` and `0.2.0-rc.2` lines. The peer range is
quoted here in full, because a README that quotes only its first `||` segment is
a trap:

```
@deepseek-ai/dsh-tools: >=0.1.7-rc.2 <0.2.0 || >=0.2.0-rc.2 <0.2.0
```

Both lines are pinned by `npm run test:probe-lines`, which installs the whole
line, builds, and runs the suite against it. Zero runtime dependencies.

## Running the checks

```sh
npm test                        # tsc, then the behaviour suite through a real ToolRuntime
python3 scripts/calibrate-history-expansion.py   # the rule against a real interactive bash (45/45)
node scripts/probe-bang-matrix.py                # the raw bash behaviour the rule encodes
node scripts/inject-defects.mjs # mutate the source; every arm must be caught by the suite
npm run test:probe-lines        # every peer line the manifest admits
```

`test/guard.spec.mjs` drives the shipped pipeline, not a mock: a real cordis
context, the real `ToolRuntime`, real tool definitions, and only the tool *body*
fabricated. Every refusal is paired with a control arm — the same command with
the plugin absent, which must run — so "the call failed" means "this plugin
refused it" rather than "the registry failed".

## License

MIT
