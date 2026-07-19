#!/usr/bin/env python3

from __future__ import annotations

import sys
from pathlib import Path

# 把脚本目录加入 sys.path，让同级模块可以直接 import。
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
