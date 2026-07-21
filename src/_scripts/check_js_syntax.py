#!/usr/bin/env python3
"""Lightweight JS syntax sanity check (brackets + common parse traps)."""
from __future__ import annotations

import re
import sys
from pathlib import Path


def _regex_start(text: str, i: int) -> bool:
    j = i - 1
    while j >= 0 and text[j] in ' \t\r\n':
        j -= 1
    if j < 0:
        return True
    prev = text[j]
    if prev in '([{=,:;!&|?+-*%^~<>':
        return True
    if prev in ')]}.':
        return False
    if prev == '/':
        return False
    if prev.isalnum() or prev in '_$':
        return False
    k = j
    while k >= 0 and (text[k].isalnum() or text[k] in '_$'):
        k -= 1
    word = text[k + 1:j + 1]
    return word in (
        'return', 'case', 'throw', 'else', 'typeof', 'void', 'delete', 'new',
        'in', 'of', 'instanceof', 'do', 'await', 'yield',
    )


def _skip_regex(text: str, i: int) -> int:
    """Advance past /pattern/flags; i points at opening slash."""
    i += 1
    n = len(text)
    in_class = False
    while i < n:
        ch = text[i]
        if ch == '\\':
            i += 2
            continue
        if ch == '[' and not in_class:
            in_class = True
            i += 1
            continue
        if ch == ']' and in_class:
            in_class = False
            i += 1
            continue
        if ch == '/' and not in_class:
            i += 1
            while i < n and text[i] in 'gimsuvyd':
                i += 1
            return i
        i += 1
    return n


def strip_js(text: str) -> str:
    out = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ''

        if ch == '/' and nxt == '/':
            i += 2
            while i < n and text[i] not in '\r\n':
                i += 1
            continue
        if ch == '/' and nxt == '*':
            i += 2
            while i + 1 < n and not (text[i] == '*' and text[i + 1] == '/'):
                i += 1
            i = min(i + 2, n)
            continue
        if ch == '/' and _regex_start(text, i):
            out.append(' ')
            i = _skip_regex(text, i)
            continue
        if ch in ('"', "'", '`'):
            quote = ch
            out.append(' ')
            i += 1
            while i < n:
                c = text[i]
                if c == '\\':
                    i += 2
                    continue
                if quote == '`' and c == '$' and i + 1 < n and text[i + 1] == '{':
                    out.append(' ')
                    i += 2
                    depth = 1
                    while i < n and depth:
                        if text[i] == '{':
                            depth += 1
                        elif text[i] == '}':
                            depth -= 1
                        i += 1
                    continue
                if c == quote:
                    i += 1
                    break
                i += 1
            continue

        out.append(ch)
        i += 1
    return ''.join(out)


def check_brackets(text: str) -> str | None:
    pairs = {'(': ')', '[': ']', '{': '}'}
    closers = {v: k for k, v in pairs.items()}
    stack: list[tuple[str, int]] = []
    line = 1
    col = 0
    for i, ch in enumerate(text):
        if ch == '\n':
            line += 1
            col = 0
            continue
        col += 1
        if ch in pairs:
            stack.append((ch, line))
        elif ch in closers:
            if not stack:
                return f'unmatched {ch!r} at line {line}, col {col}'
            open_ch, open_line = stack.pop()
            if pairs[open_ch] != ch:
                return (
                    f'mismatched {open_ch!r} (line {open_line}) and {ch!r} '
                    f'(line {line}, col {col})'
                )
    if stack:
        open_ch, open_line = stack[-1]
        return f'unclosed {open_ch!r} opened at line {open_line}'
    return None


def check_file(path: Path) -> str | None:
    text = path.read_text(encoding='utf-8')
    stripped = strip_js(text)
    err = check_brackets(stripped)
    if err:
        return err
    # Common modern-only tokens that would fail in older parsers but are fine in browsers.
    if re.search(r'\)\s*;\s*\)\s*;\s*$', stripped.strip(), re.S):
        pass
    return None


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print('usage: check_js_syntax.py <file-or-dir> [...]', file=sys.stderr)
        return 2
    failures = 0
    for arg in argv[1:]:
        p = Path(arg)
        files = sorted(p.rglob('*.js')) if p.is_dir() else [p]
        for file in files:
            if 'node_modules' in file.parts:
                continue
            err = check_file(file)
            if err:
                failures += 1
                print(f'FAIL: {file}: {err}')
            else:
                print(f'OK: {file}')
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
