/**
 * The calibrated lexical scan.
 *
 * ## What is being decided
 *
 * The persistent bash tool does not run a command the way a script would. It
 * renders it into **one** physical line of an *interactive* shell and writes that
 * line to the shell's stdin:
 *
 * ```sh
 * printf '%s\n' $'<START>'; eval -- $'<the command>'; st=$?; printf '%s%s\n' $'<END>' "$st"
 * ```
 *
 * History expansion runs on that line before bash parses anything, and an
 * interactive shell has `histexpand` on by default. When the expander reaches a
 * `!` it cannot resolve it prints `bash: !word: event not found` and **discards
 * the whole line** — the `eval`, the exit-status capture, and the closing
 * `printf` included. The tool then polls a scrollback that will never contain its
 * end marker until `timeoutMs` expires: 300 seconds, per the shipped default.
 *
 * So the question this module answers is narrow and mechanical: *does history
 * expansion reach a `!` in this command?* Nothing here is a guess about intent.
 *
 * ## Why the answer is not a local test
 *
 * It would be pleasant if "a `!` that is not escaped" were the answer. It is not,
 * because the expander tracks its own state across the line and the wrapper's
 * escaping perturbs that state. The rule below was therefore **measured**, not
 * reasoned: `scripts/calibrate-history-expansion.py` builds the exact line the
 * wrapper builds, feeds it to an interactive `bash --noprofile --norc -i`, and
 * compares the verdict with this scan. Four facts came out of that measurement,
 * and each one surprised the first attempt:
 *
 * 1. **A backslash immediately before the designator suppresses it** — and only
 *    the character *immediately* before matters, because the wrapper doubles
 *    every backslash the caller writes (`\` → `\\`) before bash sees it.
 * 2. **A following space or `=` suppresses it** — but not a tab, which the manual
 *    names and this build ignores, and not a newline (the wrapper renders it as
 *    `\n`, so the character bash sees after the `!` is a backslash) nor the end of
 *    the command (the next character is the wrapper's own closing quote).
 * 3. **The wrapper's `$'…'` quoting protects a `!` only until the first `'` the
 *    caller wrote.** The wrapper renders that `'` as `\'`, and the expander reads
 *    the `'` as the region's end without honouring the backslash — so from the
 *    first single quote onward the command text is unprotected. This is the fact
 *    the whole guard turns on, and it is why `echo 'hi!'` hangs the shell while
 *    `echo "hi!"` does not.
 * 4. **A `#` that begins a comment stops expansion for the rest of the line**,
 *    but only for the comment openers bash's *interactive reader* accepts. A
 *    preceding space, `;` or `&` works; a tab, `|` or `}` does not — measured,
 *    and encoded in {@link COMMENT_PRECEDERS} exactly as measured rather than as
 *    one might expect from the lexer's rules.
 *
 * ## The direction that matters
 *
 * Every deliberate looseness in this module leans the same way: toward
 * **not** reporting a designator. A missed designator leaves the deployment
 * exactly as it is today (a hang that upstream's one-line fix removes); a
 * spurious one refuses a command that works. {@link designators} therefore
 * reports only what the measurement says is certain, and the caller fails open
 * on anything it cannot read.
 *
 * @module @argszero/dsh-histexpand-guard/scan
 */

/**
 * Characters that inhibit history expansion when they follow the designator.
 *
 * A space and `=` only, and both absences are measured rather than inherited from
 * the manual. A **tab** is listed as an inhibitor in `man bash` and does **not**
 * inhibit this build: `echo 'a' !\tthere` loses the line to
 * `bash: !there': event not found`. A trailing **newline** or carriage return is
 * absent for a different reason — the wrapper renders them as the two characters
 * `\n` and `\r`, so what bash sees after the `!` is a backslash, which is not an
 * inhibitor either.
 */
export const INHIBITORS = ' =' as const

/**
 * Characters before a `#` that make it open a comment *for the history
 * expander*.
 *
 * Deliberately narrower than the shell's own comment rule, because it is the
 * expander's behaviour that decides whether the designator after it is reached.
 * A tab, `|` or `}` before a `#` was measured **not** to suppress expansion, so
 * they are absent: including them would turn a command that hangs into one this
 * guard allows, which is the wrong way to be wrong.
 */
export const COMMENT_PRECEDERS = ' ;&' as const

/** One designator history expansion would act on. */
export interface Designator {
  /** Index of the `!` in the caller's command. */
  readonly index: number
  /** The designator as read, `!` plus the character that follows it (at most two characters). */
  readonly text: string
}

/**
 * The exact physical text the persistent bash tool hands to the shell for one
 * command.
 *
 * A port of `quoteForBash` from
 * `packages/shell/tool-bash-persistent/src/index.ts`, kept here because the scan
 * is only correct with respect to *this* transform: the doubling of backslashes
 * is what makes fact 1 a local test, and the escaping of `'` is what makes fact 3
 * true. `test/guard.spec.mjs` pins the port against the upstream shape.
 * @param command - the caller's command.
 * @returns the `$'…'` literal the wrapper builds.
 */
export function wrappedLiteral(command: string): string {
  return `$'${command
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')}'`
}

/**
 * Whether a `#` opening a comment appears before `limit`.
 *
 * The position of the `#` is read in the caller's command, which is where the
 * three {@link COMMENT_PRECEDERS} survive the wrapper unchanged: a space, `;` or
 * `&` is passed through, a newline becomes the two characters `\n`, and a tab is
 * passed through but does not open a comment for the expander.
 * @param command - the caller's command.
 * @param limit - exclusive upper bound (the designator's index).
 * @returns true when expansion stopped before the designator.
 */
function commentOpensBefore(command: string, limit: number): boolean {
  for (let index = 1; index < limit; index += 1) {
    if (command[index] !== '#') continue
    const before = command[index - 1]
    if (before !== undefined && COMMENT_PRECEDERS.includes(before)) return true
  }
  return false
}

/**
 * Every `!` in the command that history expansion would act on.
 *
 * The four tests are applied in cheapest-first order and all four must fail for a
 * `!` to be reported. `'` is searched for once, outside the loop, because the
 * region it closes never reopens (fact 3).
 * @param command - the caller's command.
 * @returns the designators, in source order; empty when the command is safe.
 */
export function designators(command: string): Designator[] {
  const found: Designator[] = []
  const firstQuote = command.indexOf("'")
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] !== '!') continue
    if (index > 0 && command[index - 1] === '\\') continue
    const following = command[index + 1]
    if (following !== undefined && INHIBITORS.includes(following)) continue
    if (firstQuote < 0 || index < firstQuote) continue
    if (commentOpensBefore(command, index)) continue
    found.push({ index, text: command.slice(index, index + 2) })
  }
  return found
}

/**
 * Whether history expansion would reach any designator in the command.
 * @param command - the caller's command.
 * @returns true when the persistent shell would drop the line.
 */
export function hasDesignator(command: string): boolean {
  return designators(command).length > 0
}
