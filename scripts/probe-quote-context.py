#!/usr/bin/env python3
"""Focused probe of the quote context around an unescaped `!`.

The rule needs to know when bash's history expander still reaches a `!` after
the wrapper has rewritten the command into `$'…'`. This probe varies one thing
at a time and prints the raw result, so the rule can be derived from data
rather than from a theory of bash's scanner.
"""
from __future__ import annotations

import os
import subprocess
import sys
import uuid

SHELL = os.environ.get("SHELL_PATH", "/bin/bash")


def quote_for_bash(value: str) -> str:
    return ("$'" + value.replace("\\", "\\\\").replace("'", "\\'")
            .replace("\r", "\\r").replace("\n", "\\n") + "'")


def run(command: str) -> tuple[str, str]:
    nonce = uuid.uuid4()
    start, end = f"S{nonce}", f"E{nonce}"
    line = ("printf '%s\\n' " + quote_for_bash(start) + "; eval -- " + quote_for_bash(command)
            + "; st=$?; printf '%s%s\\n' " + quote_for_bash(end) + ' "$st"')
    env = dict(os.environ, HISTFILE="/dev/null")
    try:
        done = subprocess.run([SHELL, "--noprofile", "--norc", "-i"], input=line + "\n",
                              capture_output=True, text=True, timeout=20, env=env)
    except subprocess.TimeoutExpired:
        return "hung", ""
    seen = (done.stdout or "") + (done.stderr or "")
    if start not in seen or end not in seen:
        return "dropped", seen
    for token in ("event not found", "syntax error"):
        if token in seen:
            return "mangled", seen
    return "intact", seen


CASES = [
    ("a  ! alone in the payload", "!echo hi"),
    ("b  bare bang after a space", "echo !m"),
    ("c  one escaped quote pair before", "echo 'a' !m"),
    ("d  escaped quote pair, space, bang", "echo 'a' !m"),
    ("e  hash before the bang", "echo 'a' # !/usr/bin/env node"),
    ("f  hash before bang, no quotes", "node -e x # !/usr/bin/env node"),
    ("g  bang right after an escaped quote", "echo 'a'!m"),
    ("h  bang after two escaped quote pairs", "echo 'a' 'b' !m"),
    ("i  bang after an unescaped double quote", 'echo "a" !m'),
    ("j  bang at start of a second line", "echo one\n!second"),
    ("k  bang at start of a first line", "!first\necho two"),
    ("l  shebang in a bare heredoc, line 2", "cat > x.sh <<EOF\n#!/usr/bin/env bash\nEOF"),
    ("m  shebang in a bare heredoc, line 1", "#!/usr/bin/env bash"),
    ("n  bang after a double-quoted word", 'cat <<"EOF"\n#!/bin/sh\nEOF'),
    ("o  js bang word with parens", "console.log('!important')"),
    ("p  bang after an escaped quote in double quotes", "echo \"it's !m\""),
    ("q  two bangs", "echo 'a' !m 'b' !n"),
    ("r  bang after a lone backslash-quote", "echo \\'a\\' !m"),
    ("s  bang after an unquoted letter", "echo a!m"),
    ("t  bang after an unquoted digit", "echo a1!m"),
]

for label, command in CASES:
    verdict, seen = run(command)
    detail = ""
    for raw in seen.splitlines():
        if "event not found" in raw or "syntax error" in raw:
            detail = raw.strip()[:80]
    print(f"{verdict:<8} {label:<52} {detail}")
