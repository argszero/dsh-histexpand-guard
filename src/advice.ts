/**
 * The denial text.
 *
 * A refusal the model cannot act on costs a turn: it sees `Error: <reason>`, has
 * no other signal about what was wrong, and retries a command that will be refused
 * again. So this text says three things in order — what was read, why the reading
 * is certain, and what to write instead — and the third part is specific, because
 * "escape it" is wrong advice for the case that matters most: a `!` that is
 * *content*, like the shebang inside a heredoc, where a backslash would be written
 * into the file.
 *
 * The remedies are ordered by how little they change: writing the file with a file
 * tool, then a rewrite that keeps the command's meaning, then the escape that
 * changes it, and last the two ways to remove the hazard for the whole session.
 *
 * @module @argszero/dsh-histexpand-guard/advice
 */

import type { Finding } from './policy.ts'

/** The head line: what happened, in the order the operator will read it. */
const HEAD = 'histexpand-guard refused this command before it ran: the persistent bash shell would have '
  + 'discarded the line, and the call would have hung until its command deadline.'

/** The mechanism, stated once. */
const WHY = [
  'The persistent bash tool writes each command into an *interactive* shell as one `$\'…\'` line,',
  'and bash expands history (`!…`) there before it parses anything. A `!` bash cannot resolve',
  'makes it discard the whole line, the end-of-command marker included, so the call hangs until',
  '`timeoutMs` (300 seconds by default). The wrapper\'s quoting stops protecting the command at',
  'the first single quote in it: `echo "hi!"` runs, `echo \'hi!\'` does not.',
].join('\n')

/** The remedies, in the order they cost the least. */
const REMEDIES = [
  'Write instead — any one of these:',
  '  1. Write the file with a file tool rather than a shell heredoc. Nothing about a shebang',
  '     needs a shell.',
  '  2. Keep the `!` away from an earlier single quote: a bare heredoc delimiter (`<<EOF`, not',
  '     `<<\'EOF\'`) when the body has no `$`, or a double-quoted string.',
  '  3. Escape it as `\\!` when a literal backslash is acceptable — it changes the text that',
  '     reaches the program, so it is wrong for a shebang.',
  '  4. Remove the hazard for the session: mount this guard with `arm: true`, which writes',
  '     `set +o histexpand` into the agent\'s shell. Upstream, that same line next to the',
  '     `stty -echo` the persistent tool already sends fixes it for every command.',
].join('\n')

/** The closing line: the model must not think the command ran. */
const TRAILER = 'Nothing was executed.'

/**
 * Render the denial for one command.
 *
 * The result is bounded because it is delivered to the model inside an error
 * result: a text that can grow without a bound is a text that can displace the
 * conversation it is meant to correct. The budget is spent in one order — the
 * mechanism and the remedies are never dropped, the excerpts are dropped whole
 * when the first two no longer fit beside them, and only when even those do not
 * fit is the text cut. The trailer survives every one of those outcomes, because
 * it is the line that stops the model believing the command ran.
 * @param findings - every designator this command would hand to history expansion.
 * @param maxChars - the inclusive bound for the whole reason.
 * @returns the denial reason.
 */
export function renderDenial(findings: readonly Finding[], maxChars: number): string {
  if (maxChars <= 0) return ''
  const read = findings
    .map(finding => `  • ${finding.designator.text}   (in …${finding.excerpt}…)`)
    .join('\n')
  const withExcerpts = [HEAD, WHY, `Read here:\n${read}`, REMEDIES].join('\n\n')
  const withoutExcerpts = [HEAD, WHY, REMEDIES].join('\n\n')
  for (const body of [withExcerpts, withoutExcerpts]) {
    const whole = `${body}\n\n${TRAILER}`
    if (whole.length <= maxChars) return whole
  }
  const room = Math.max(0, maxChars - TRAILER.length - 3)
  return `${withoutExcerpts.slice(0, room)}…\n\n${TRAILER}`
}
