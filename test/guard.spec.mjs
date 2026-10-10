/**
 * The behaviour of the guard, measured through the shipped registry pipeline.
 *
 * Every refusal is paired with a control: the same command, the same world, with
 * the plugin absent, must *run*. That is what makes "the call failed" mean "this
 * plugin refused it" rather than "the registry failed".
 *
 * The command corpus is the calibration's corpus
 * (`scripts/calibrate-history-expansion.py`), so the rule and the shell are held
 * to the same list: every command marked hazardous here was measured to lose the
 * line in a real interactive bash, and every one marked safe was measured to run.
 * The calibration script is the authority; this file is the contract.
 *
 * @module test/guard.spec
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { world, run, resultText, logText, fakeTerminals, SIGNAL } from './harness.mjs'

/** Commands the measurement says lose the line in a persistent shell. */
const HAZARDOUS = [
  ['quoted heredoc delimiter with a shebang body (#9240)', "cat > x.sh <<'EOF'\n#!/usr/bin/env bash\nEOF"],
  ['single-quoted shebang through printf', "printf '%s\\n' '#!/bin/sh' > x.sh"],
  ['commit message ending in a bang', "git commit -m 'fix: wip!'"],
  ['a quoted word ending in a bang', "echo 'hi!'"],
  ['grep for a literal bang', "grep -n '!' file.txt"],
  ['python -c with a bang in the program', 'python3 -c \'print("!")\''],
  ['a bang right after a closing quote', "echo 'a'!m"],
  ['two quoted words then a bang', "echo 'a' 'b' !m"],
  ['a double-quoted word containing an apostrophe', 'echo "don\'t" "!x"'],
  ['a bang whose follower is an escaped quote', "echo 'a' !'q'"],
  ['a bang followed by a newline', "echo 'a' !\necho tail"],
  ['a bang followed by a backslash', 'echo \'a\' !\\m'],
  ['a bang at the end of the command', "echo 'a' !"],
  ['a bang then hash designator', "echo 'a' !#x"],
  ['a bang followed by a tab, which does not inhibit', "echo 'a' !\tthere"],
  ['a comment opener preceded by a tab, which does not open one', "echo 'a'\t# !m"],
  ['a comment opener preceded by a pipe, which does not open one', "echo 'a' |# !m"],
]

/** Commands the measurement says run unchanged in a persistent shell. */
const SAFE = [
  ['a plain command', 'echo hello'],
  ['a bare heredoc with a shebang body', 'cat > x.sh <<EOF\n#!/usr/bin/env bash\nEOF'],
  ['a shebang as the whole command', '#!/usr/bin/env bash'],
  ['a bare heredoc with a double-quoted delimiter', 'cat <<"EOF"\n#!/bin/sh\nEOF'],
  ['a double-quoted word ending in a bang', 'echo "hi!"'],
  ['a quoted verbatim string before any quote', 'echo \'a\' \\!b'],
  ['an escaped bang inside a quoted word', "echo 'a \\! b'"],
  ['a backslash-doubled bang', "echo 'a' \\\\!b"],
  ['bang-equals in a test', "[ 'a' != 'b' ] && echo different"],
  ['a bang followed by a space', "echo 'a' ! there"],
  ['a bang followed by an equals sign', "[ 'a' != 'b' ] && echo different"],
  ['a bang inside a comment after a space', "echo 'a' # !m"],
  ['a bang inside a comment after a semicolon', "echo 'a' ;# !m"],
  ['a comment opener inside a quoted word', "sed -i '1i #!/bin/sh' x.sh"],
  ['a bang before any single quote', 'echo "!" \'a\''],
  ['a bang at the start of the command', '!echo hi'],
  ['a bang at the start of a later line', 'echo one\n!second'],
  ['a jq expression with a bang-equals', "jq '.a != null' x.json"],
  ['a quoted heredoc whose body has no bang', "cat > x.sh <<'EOF'\nhello\nEOF"],
]

test('refuses every command the measurement says would lose the line', async () => {
  for (const [label, command] of HAZARDOUS) {
    const guarded = await world()
    const guardedResult = await run(guarded, command)
    assert.equal(guardedResult.isError, true, `${label}: expected a refusal`)
    assert.match(resultText(guardedResult), /histexpand-guard refused this command/)
    assert.equal(guarded.ran.length, 0, `${label}: the body must not have run`)

    const control = await world({ plugin: false })
    const controlResult = await run(control, command)
    assert.notEqual(controlResult.isError, true, `${label}: control must run`)
    assert.deepEqual(control.ran, [{ command }], `${label}: control must reach the body`)
  }
})

test('allows every command the measurement says runs', async () => {
  for (const [label, command] of SAFE) {
    const guarded = await world()
    const result = await run(guarded, command)
    assert.notEqual(result.isError, true, `${label}: must not be refused — ${resultText(result)}`)
    assert.deepEqual(guarded.ran, [{ command }], `${label}: must reach the body`)
  }
})

test('never acts on a `bash` tool whose shell is not the persistent contract', async () => {
  // `oneshot` is the shipped one-shot tool; `stringy`, `silent` and `optional`
  // each differ from the persistent contract in exactly one clause of the
  // identity check, so this loop is what makes each clause load-bearing.
  for (const shellShape of ['oneshot', 'stringy', 'silent', 'optional']) {
    for (const [, command] of HAZARDOUS) {
      const harness = await world({ shellShape })
      const result = await run(harness, command)
      assert.notEqual(result.isError, true, `${shellShape} bash must run: ${command} — ${resultText(result)}`)
      assert.deepEqual(harness.ran, [{ command }])
    }
  }
})

test('assumePersistentShell acts without a resolvable definition', async () => {
  const harness = await world({ shellShape: 'oneshot', config: { assumePersistentShell: true } })
  const result = await run(harness, "git commit -m 'fix: wip!'")
  assert.equal(result.isError, true)
  assert.equal(harness.ran.length, 0)
})

test('a tool outside onlyTools is never inspected', async () => {
  const harness = await world({ toolName: 'shell_exec', config: { onlyTools: ['bash'] } })
  const result = await run(harness, "echo 'hi!'")
  assert.notEqual(result.isError, true)
  assert.deepEqual(harness.ran, [{ command: "echo 'hi!'" }])
})

test('an empty onlyTools list inspects any tool with a command argument', async () => {
  const harness = await world({ toolName: 'shell_exec', config: { onlyTools: [] } })
  const result = await run(harness, "echo 'hi!'")
  assert.equal(result.isError, true)
})

test('report mode lets the command through', async () => {
  const harness = await world({ config: { mode: 'report' } })
  const result = await run(harness, "echo 'hi!'")
  assert.notEqual(result.isError, true)
  assert.deepEqual(harness.ran, [{ command: "echo 'hi!'" }])
  assert.match(logText(harness.logged), /histexpand-guard \(report\)/)
})

test('off installs nothing at all', async () => {
  const harness = await world({ config: { mode: 'off' } })
  const result = await run(harness, "echo 'hi!'")
  assert.notEqual(result.isError, true)
  assert.equal(harness.ctx.tools.get('histexpand_check'), undefined)
})

test('exempt entries are substring matches', async () => {
  const harness = await world({ config: { exempt: ['git commit'] } })
  const result = await run(harness, "git commit -m 'fix: wip!'")
  assert.notEqual(result.isError, true)
  assert.deepEqual(harness.ran, [{ command: "git commit -m 'fix: wip!'" }])
})

test('the reason names the designator, the mechanism and a remedy, and is bounded', async () => {
  const harness = await world()
  const result = await run(harness, "cat > x.sh <<'EOF'\n#!/usr/bin/env bash\nEOF")
  const text = resultText(result)
  assert.match(text, /Read here:/)
  assert.match(text, /event not found|discarded the line/)
  assert.match(text, /Write instead/)
  assert.match(text, /Nothing was executed\./)
  assert.ok(text.length <= 'Error: '.length + 1600, `reason must respect maxReasonChars, got ${text.length}`)

  const tiny = await world({ config: { maxReasonChars: 200 } })
  const tinyText = resultText(await run(tiny, "echo 'hi!'"))
  assert.ok(tinyText.length <= 'Error: '.length + 200, `bounded reason expected, got ${tinyText.length}`)
  assert.match(tinyText, /Nothing was executed\./)
})

test('maxReportedDesignators bounds how many designators one denial names', async () => {
  const harness = await world({ config: { maxReportedDesignators: 1 } })
  const text = resultText(await run(harness, "echo 'a' !m 'b' !n 'c' !o"))
  assert.equal((text.match(/•/g) ?? []).length, 1)
})

test('the check tool answers without running anything', async () => {
  const harness = await world()
  const refused = await harness.ctx.tools.execute({
    signal: SIGNAL, callId: 'c1', name: 'histexpand_check', arguments: { command: "echo 'hi!'" },
  })
  const refusedText = resultText(refused)
  assert.match(refusedText, /REFUSED \(enforce mode\)/)
  assert.match(refusedText, /the persistent shell shape/)
  assert.match(refusedText, /\$'echo \\'hi!\\''/)
  assert.equal(harness.ran.length, 0)

  const allowed = await harness.ctx.tools.execute({
    signal: SIGNAL, callId: 'c2', name: 'histexpand_check', arguments: { command: 'echo "hi!"' },
  })
  assert.match(resultText(allowed), /ALLOWED: no history-expansion designator/)

  const oneShot = await world({ shellShape: 'oneshot' })
  const notIdentified = await oneShot.ctx.tools.execute({
    signal: SIGNAL, callId: 'c3', name: 'histexpand_check', arguments: { command: "echo 'hi!'" },
  })
  const notIdentifiedText = resultText(notIdentified)
  assert.match(notIdentifiedText, /NOT the persistent shell shape/)
  assert.match(notIdentifiedText, /The guard would not act on this call\./)

  const exempt = await world({ config: { exempt: ['hi'] } })
  const exemptText = resultText(await exempt.ctx.tools.execute({
    signal: SIGNAL, callId: 'c4', name: 'histexpand_check', arguments: { command: "echo 'hi!'" },
  }))
  assert.match(exemptText, /ALLOWED \(exempt\)/)
})

test('arm writes the disarm line into the live shell and then lets the command through', async () => {
  const terminals = fakeTerminals()
  const harness = await world({ config: { arm: true }, terminals })
  const result = await run(harness, "echo 'hi!'", { agent: true })
  assert.notEqual(result.isError, true)
  assert.deepEqual(harness.ran, [{ command: "echo 'hi!'" }])
  assert.deepEqual(terminals.sent.map(entry => entry.text), ['set +o histexpand'])
  assert.equal(terminals.sent[0].submit, true)
})

test('arm is idempotent per session', async () => {
  const terminals = fakeTerminals()
  const harness = await world({ config: { arm: true }, terminals })
  await run(harness, "echo 'hi!'", { agent: true })
  await run(harness, "echo 'hi!'", { agent: true })
  assert.equal(terminals.sent.length, 1)
  assert.equal(harness.ran.length, 2)
})

test('arm falls back to the refusal when there is no live shell to arm', async () => {
  const terminals = fakeTerminals([])
  const harness = await world({ config: { arm: true }, terminals })
  const result = await run(harness, "echo 'hi!'", { agent: true })
  assert.equal(result.isError, true)
  assert.equal(terminals.sent.length, 0)
  assert.equal(harness.ran.length, 0)
})

test('arm falls back to the refusal when there is no PTY service at all', async () => {
  const harness = await world({ config: { arm: true } })
  const result = await run(harness, "echo 'hi!'", { agent: true })
  assert.equal(result.isError, true)
})

test('a failed arming send is logged, and the refusal still stands', async () => {
  const terminals = fakeTerminals()
  terminals.failWith('pty-1', new Error('SEND_ACTIVE'))
  const harness = await world({ config: { arm: true }, terminals })
  const result = await run(harness, "echo 'hi!'", { agent: true })
  assert.equal(result.isError, true)
  assert.match(logText(harness.logged), /arming the persistent shell failed, allowing the call/)
})

test('tool: false keeps the refusal and skips the inspection tool', async () => {
  const harness = await world({ config: { tool: false } })
  assert.equal(harness.ctx.tools.get('histexpand_check'), undefined)
  const result = await run(harness, "echo 'hi!'")
  assert.equal(result.isError, true)
})
