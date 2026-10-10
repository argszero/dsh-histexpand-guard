#!/usr/bin/env python3
"""Map the invariant: when does an unescaped `!` still reach history expansion?

The wrapper rewrites the command into one `$'…'` physical line, escaping `\\`,
`'`, CR and LF. Bash's history expander runs on that line first, and it tracks
its own quote state. This probe varies one dimension at a time and prints the
verdict, so the invariant can be read off rather than theorised.
"""
from __future__ import annotations

import os
import subprocess
import uuid

SHELL = os.environ.get("SHELL_PATH", "/bin/bash")


def quote_for_bash(value: str) -> str:
    return ("$'" + value.replace("\\", "\\\\").replace("'", "\\'")
            .replace("\r", "\\r").replace("\n", "\\n") + "'")


def verdict(command: str) -> str:
    nonce = uuid.uuid4()
    start, end = f"S{nonce}", f"E{nonce}"
    line = ("printf '%s\\n' " + quote_for_bash(start) + "; eval -- " + quote_for_bash(command)
            + "; st=$?; printf '%s%s\\n' " + quote_for_bash(end) + ' "$st"')
    env = dict(os.environ, HISTFILE="/dev/null")
    try:
        done = subprocess.run([SHELL, "--noprofile", "--norc", "-i"], input=line + "\n",
                              capture_output=True, text=True, timeout=20, env=env)
    except subprocess.TimeoutExpired:
        return "HUNG"
    seen = (done.stdout or "") + (done.stderr or "")
    if start not in seen or end not in seen:
        return "DROPPED"
    for token in ("event not found", "syntax error"):
        if token in seen:
            return "MANGLED"
    return "intact"


def report(title: str, cases: list[tuple[str, str]]) -> None:
    print(f"--- {title}")
    for label, command in cases:
        rendered = quote_for_bash(command)
        print(f"  {verdict(command):<8} {label:<34} {rendered}")


# 1. How many escaped quote pairs precede a space-then-bang.
report("N escaped quote pairs, then ` !m`", [
    (f"{n} pair(s)", "echo " + "'a' " * n + "!m") for n in range(0, 5)
])

# 2. Plain quoted word, no escape perturbation, then bang.
report("plain quoted word before bang", [
    ("single-quoted word", "echo 'a' !m"),
    ("double-quoted word", 'echo "a" !m'),
    ("no quotes at all", "echo a !m"),
    ("bang right after the word", "echo a!m"),
    ("bang after a space only", "echo !m"),
    ("bang alone", "!m"),
])

# 3. What follows the bang (fixed context: one escaped pair before).
report("`echo 'a' !<X>` for various X", [
    (f"bang + {repr(x)}", "echo 'a' !" + x) for x in ["m", "/usr", "$x", "-1", "#x", "(", "a"]
])

# 4. Same, but with the escaped pair removed (bare context).
report("`echo !<X>` for various X", [
    (f"bang + {repr(x)}", "echo !" + x) for x in ["m", "/usr", "$x", "-1", "#x", "a"]
])

# 5. A hash anywhere before the bang.
report("hash before the bang", [
    ("escaped pair, hash, bang", "echo 'a' # !m"),
    ("escaped pair, hash no space, bang", "echo 'a' #!m"),
    ("hash only", "echo # !m"),
    ("escaped pair, comment line, bang", "echo 'a'  # note\n!m"),
])

# 6. A heredoc, quoted vs bare.
report("heredoc shebang, quoted vs bare", [
    ("quoted delimiter", "cat > x.sh <<'EOF'\n#!/usr/bin/env bash\nEOF"),
    ("bare delimiter", "cat > x.sh <<EOF\n#!/usr/bin/env bash\nEOF"),
    ("quoted delimiter, single line", "cat <<'EOF'\n#!/bin/sh\nEOF"),
])
