#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

# Reuse strip_js from same package logic inline for a second pass.
from check_js_syntax import check_file


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    files = sorted(
        p for p in root.rglob('*.js')
        if 'node_modules' not in p.parts
    )
    failures = 0
    for file in files:
        err = check_file(file)
        rel = file.relative_to(root)
        if err:
            failures += 1
            print(f'FAIL: {rel}: {err}')
        else:
            print(f'OK: {rel}')
    print('---')
    print(f'Checked {len(files)} files, {failures} failed')
    return 1 if failures else 0


if __name__ == '__main__':
    raise SystemExit(main())
