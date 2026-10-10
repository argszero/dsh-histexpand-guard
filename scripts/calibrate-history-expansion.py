#!/usr/bin/env python3
"""Calibrate the guard's rule against the real shell, and show the evidence.

The rule is a claim about bash: inside the persistent-bash wrapper's own physical
line, a `!` in the model's command reaches history expansion unless one of the
suppressions in `src/scan.ts` applies. A claim like that is worth nothing
unmeasured, so this script

  1. builds the *exact* physical line `tool-bash-persistent.wrapCommand` builds
     (`quoteForBash` escaping, `eval --`, both markers),
  2. feeds it to an interactive `bash` reading stdin — `bash --noprofile --norc
     -i`, the argv `terminal-bash` defaults to, with `HISTFILE=/dev/null` so that a
     matching history entry cannot silently substitute instead of erroring,
  3. classifies what happened (a dropped line never prints the end marker; a line
     rewritten by `!#` can print both markers while the payload never ran, so the
     payload's own output is the tie-breaker), and
  4. compares that with the rule this plugin implements, mirrored below in Python.

The mirror is a port, not an import: the point is to check the TypeScript rule
against a shell, so an accidental shared implementation would defeat it. The two
are kept in step by `test/guard.spec.mjs`, which asserts the same corpus.

Exit status is non-zero when the rule and the shell disagree, so this is both the
evidence for the README and a regression gate for the rule.

Usage:
    python3 scripts/calibrate-history-expansion.py [--shell /bin/bash] [-v]

Measured on the machine this plugin was written at:
`/bin/bash` 3.2.57 (the macOS default), 27/27 agreement.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import uuid

# ---------------------------------------------------------------------------
# The production wrapper, ported from
# packages/shell/tool-bash-persistent/src/index.ts (`quoteForBash`,
# `wrapCommand`, `markers`).
# ---------------------------------------------------------------------------


def quote_for_bash(value: str) -> str:
    return (
        "$'"
        + value.replace("\\", "\\\\").replace("'", "\\'").replace("\r", "\\r").replace("\n", "\\n")
        + "'"
    )


def wrap_command(command: str) -> tuple[str, str, str]:
    nonce = uuid.uuid4()
    start = f"__DSH_PERSISTENT_BASH_START_{nonce}__"
    end = f"__DSH_PERSISTENT_BASH_END_{nonce}:"
    line = (
        "printf '%s\\n' " + quote_for_bash(start)
        + "; eval -- " + quote_for_bash(command)
        + "; __dsh_persistent_bash_status=$?; printf '%s%s\\n' " + quote_for_bash(end)
        + ' "$__dsh_persistent_bash_status"'
    )
    return line, start, end


# ---------------------------------------------------------------------------
# The rule, mirrored from src/scan.ts.
# ---------------------------------------------------------------------------

INHIBITORS = frozenset(" =")
COMMENT_PRECEDERS = " ;&"


def comment_opens_before(command: str, limit: int) -> bool:
    for index in range(1, limit):
        if command[index] != "#":
            continue
        if command[index - 1] in COMMENT_PRECEDERS:
            return True
    return False


def designators(command: str) -> list[tuple[int, str]]:
    found: list[tuple[int, str]] = []
    first_quote = command.find("'")
    for index, char in enumerate(command):
        if char != "!":
            continue
        if index > 0 and command[index - 1] == "\\":
            continue
        following = command[index + 1] if index + 1 < len(command) else None
        if following is not None and following in INHIBITORS:
            continue
        if first_quote < 0 or index < first_quote:
            continue
        if comment_opens_before(command, index):
            continue
        found.append((index, command[index : index + 2]))
    return found


def rule_refuses(command: str) -> bool:
    return len(designators(command)) > 0


# ---------------------------------------------------------------------------
# The measurement.
# ---------------------------------------------------------------------------


def run_wrapped(shell: str, command: str, timeout: float, cwd: str) -> tuple[str, str]:
    """(verdict, transcript) for one command through the production line."""
    line, start, end = wrap_command(command)
    env = dict(os.environ, HISTFILE="/dev/null")
    try:
        done = subprocess.run(  # noqa: S603 - the shell under calibration
            [shell, "--noprofile", "--norc", "-i"],
            input=line + "\n",
            capture_output=True,
            text=True,
            timeout=timeout,
            env=env,
            cwd=cwd,
        )
    except subprocess.TimeoutExpired:
        return "hung", ""
    seen = (done.stdout or "") + (done.stderr or "")
    if start not in seen or end not in seen:
        return "dropped", seen
    if "event not found" in seen or "syntax error" in seen:
        return "mangled", seen
    return "intact", seen


# Commands worth pinning. The first block is the shapes a real model writes; the
# second pins every boundary the rule names, so a change to the rule shows up as a
# disagreement rather than as a silent behaviour change.
CASES: list[tuple[str, str]] = [
    # --- shapes that reach history expansion, as reported and as measured
    ("quoted heredoc delimiter with a shebang (#9240)", "cat > x.sh <<'EOF'\n#!/usr/bin/env bash\nEOF"),
    ("single-quoted shebang through printf", "printf '%s\\n' '#!/bin/sh' > x.sh"),
    ("commit message ending in a bang", "git commit -m 'fix: wip!'"),
    ("a quoted word ending in a bang", "echo 'hi!'"),
    ("grep for a literal bang", "grep -n '!' file.txt"),
    ("python -c with a bang in the program", 'python3 -c \'print("!")\''),
    ("a bang right after a closing quote", "echo 'a'!m"),
    ("two quoted words then a bang", "echo 'a' 'b' !m"),
    ("a double-quoted word containing an apostrophe", 'echo "don\'t" "!x"'),
    ("four quoted words then a bang", "echo 'a' 'a' 'a' 'a' !m"),
    # --- shapes that do not, including the ones a first guess gets wrong
    ("plain command, no bang", "echo hello"),
    ("bare heredoc delimiter with a shebang", "cat > x.sh <<EOF\n#!/usr/bin/env bash\nEOF"),
    ("a shebang as the whole command", "#!/usr/bin/env bash"),
    ("double-quoted heredoc delimiter", 'cat <<"EOF"\n#!/bin/sh\nEOF'),
    ("a double-quoted word ending in a bang", 'echo "hi!"'),
    ("a bang with no quote before it", "echo !m"),
    ("a bang after an unquoted letter", "echo a!m"),
    ("a bang at the start of the command", "!echo hi"),
    ("a bang at the start of a later line", "echo one\n!second"),
    ("a bang before the first quote", 'echo "!" \'a\''),
    ("bang-equals in a test", "[ 'a' != 'b' ] && echo different"),
    ("a jq expression with a bang-equals", "jq '.a != null' x.json"),
    # --- suppressions the rule names
    ("backslash before the bang", "echo 'a' \\!b"),
    ("two backslashes before the bang", "echo 'a' \\\\!b"),
    ("escaped bang inside a quoted word", "echo 'a \\! b'"),
    ("a bang followed by a space", "echo 'a' ! there"),
    ("a bang followed by a tab", "echo 'a' !\tthere"),
    ("a bang inside a comment after a space", "echo 'a' # !m"),
    ("a bang inside a comment after a semicolon", "echo 'a' ;# !m"),
    ("a bang inside a comment after an ampersand", "echo 'a' &# !m"),
    ("a comment opener inside a quoted word", "sed -i '1i #!/bin/sh' x.sh"),
    ("a quoted heredoc whose body has no bang", "cat > x.sh <<'EOF'\nhello\nEOF"),
    # --- boundaries the rule deliberately does not treat as comments
    ("a tab before the comment opener", "echo 'a'\t# !m"),
    ("a pipe before the comment opener", "echo 'a' |# !m"),
    ("a brace before the comment opener", "echo 'a' }# !m"),
    ("a hash inside a word", "echo 'a' x# !m"),
    ("a hash at the start of a later line", "echo 'a'\n# !m"),
    # --- followers that are not inhibitors
    ("a bang followed by a newline", "echo 'a' !\necho tail"),
    ("a bang followed by a carriage return", "echo 'a' !\recho tail"),
    ("a bang followed by a backslash", "echo 'a' !\\m"),
    ("a bang followed by a quote", "echo 'a' !'q'"),
    ("a bang at the end of the command", "echo 'a' !"),
    ("a bang then hash designator", "echo 'a' !#x"),
    ("a bang then dollar", "echo 'a' !$x"),
    ("a bang then paren", "echo 'a' !(x)"),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shell", default=os.environ.get("SHELL_PATH", "/bin/bash"))
    parser.add_argument("--timeout", type=float, default=25.0)
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    version = subprocess.run(  # noqa: S603
        [args.shell, "--version"], capture_output=True, text=True,
    ).stdout.splitlines()[0]
    print(f"shell: {args.shell} ({version})")
    print("mode:  pipe (interactive stdin), HISTFILE=/dev/null")
    print()

    agreements = 0
    mismatches: list[str] = []
    # A scratch directory, because several cases write files: a calibration must
    # not leave `x.sh` in whatever directory it was run from.
    scratch = tempfile.mkdtemp(prefix="histexpand-calibration-")
    for label, command in CASES:
        verdict, seen = run_wrapped(args.shell, command, args.timeout, scratch)
        observed = "lost" if verdict in {"dropped", "hung", "mangled"} else "ran"
        refused = rule_refuses(command)
        ok = observed == ("lost" if refused else "ran")
        agreements += ok
        bang = [text for _, text in designators(command)]
        print(f"{'ok  ' if ok else 'FAIL'} {label:<46} rule={'refuse' if refused else 'allow ':<6} "
              f"shell={observed:<5} designators={bang}")
        if args.verbose and verdict != "intact":
            for raw in seen.splitlines():
                if raw.strip():
                    print(f"        | {raw.strip()[:110]}")
        if not ok:
            mismatches.append(f"{label}: rule={'lost' if refused else 'ran'} shell={observed}")

    print()
    print(f"agreement: {agreements}/{len(CASES)}")
    print(f"scratch:   {scratch}")
    if mismatches:
        print("mismatches:")
        for entry in mismatches:
            print(f"  - {entry}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
