#!/usr/bin/env python3
"""Focused probe: which `!` shapes does an interactive bash 3.2 actually expand,
inside the persistent-bash wrapper's own physical line?"""
import os, re, subprocess, sys, uuid

SHELL = os.environ.get("SHELL_PATH", "/bin/bash")
INHIBITORS = set(" \t\n\r=")


def quote_for_bash(value: str) -> str:
    out = (value.replace("\\", "\\\\").replace("'", "\\'").replace("\r", "\\r").replace("\n", "\\n"))
    return "$'" + out + "'"


def wrap(command: str):
    nonce = uuid.uuid4()
    start, end = "__S%s__" % nonce, "__E%s:" % nonce
    line = ("printf '%s\\n' " + quote_for_bash(start) + "; eval -- " + quote_for_bash(command)
            + "; __st=$?; printf '%s%s\\n' " + quote_for_bash(end) + ' "$__st"')
    return line, start, end


def run(command: str):
    line, start, end = wrap(command)
    env = dict(os.environ, HISTFILE="/dev/null")
    try:
        done = subprocess.run([SHELL, "--noprofile", "--norc", "-i"], input=line + "\n",
                              capture_output=True, text=True, timeout=20, env=env)
    except subprocess.TimeoutExpired:
        return "timeout", ""
    seen = (done.stdout or "") + (done.stderr or "")
    if start in seen and end in seen:
        return "ran", seen
    return "lost", seen


CASES = [
    ("A  1 backslash before bang", "echo 'a' \\!b"),
    ("B  2 backslashes before bang", "echo 'a' \\\\!b"),
    ("C  3 backslashes before bang", "echo 'a' \\\\\\!b"),
    ("D  no backslash", "echo 'a' !m"),
    ("E  backslash space bang", "echo 'a' \\ !m"),
    ("F  quote directly before bang", "echo 'a'!m"),
    ("G  inner quote then bang", "echo 'a' \\'x' !m"),
    ("H  bang then backslash", "echo 'a' !\\m"),
    ("I  bang then newline", "echo 'a' !\necho tail"),
    ("J  bang then close-quoted", "echo 'a' !'q'"),
    ("K  bang then dollar", "echo 'a' !$x"),
    ("L  bang then brace", "echo 'a' !{x}"),
    ("M  bang then hash", "echo 'a' !#x"),
    ("N  bang then quote-char-direct", "echo 'a' !'"),
]

for label, command in CASES:
    payload = quote_for_bash(command)
    verdict, seen = run(command)
    error = ""
    for line in seen.splitlines():
        if "event not found" in line or "syntax error" in line:
            error = line.strip()[:90]
            break
    print("%-32s %-5s  payload=%s" % (label, verdict, payload[:60].replace("\n", "\\n")))
    if error:
        print("%-32s        %s" % ("", error))
