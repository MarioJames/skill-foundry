#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CONFIG_PATH = Path(".workspace/metadata.yaml")
DISCOVERY_PATH = Path(".workspace/state/discovery.json")
RELATION_REGISTRY_PATH = Path(".workspace/relations/registry.yaml")
RELATION_INDEX_PATH = Path(".workspace/relations/index.md")
WORKSPACE_INDEX_PATH = Path(".workspace/index.md")
REPO_DOCS_PATH = Path(".workspace/repos")
ROOT_DOC_PATHS = [Path("AGENTS.md"), Path("CLAUDE.md"), Path("MEMORY.md")]
MEMORY_DAILY_PATH = Path(".workspace/memory/daily")
IGNORED_DIRS = {
    ".git",
    ".idea",
    ".vscode",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
    # Maven / Rust 构建输出、Go/PHP vendored 依赖、Python 缓存与虚拟环境。
    "target",
    "vendor",
    "__pycache__",
    ".venv",
    ".workspace",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(read_text(path))


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


def write_json(path: Path, data: Any) -> None:
    write_text(path, json.dumps(data, ensure_ascii=False, indent=2))


def rel_link(from_path: Path, target: Path) -> str:
    return os.path.relpath(target, start=from_path.parent).replace(os.sep, "/")


def md_link(label: str, from_path: Path, target: Path) -> str:
    return f"[{label}]({rel_link(from_path, target)})"


def escape_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", "<br>")


def render_category_cell(value: str) -> str:
    """类别字段渲染成一个代码标签，除非值里本来就有行内代码。"""
    escaped = escape_cell(value)
    if "`" in value:
        return escaped
    return f"`{escaped}`"


def unescape_cell(value: str) -> str:
    return value.replace("\\|", "|").replace("<br>", "\n").strip()


def strip_inline_links(value: str) -> str:
    # 文档表摘要提取自 `## 摘要` 下第一段。该段落里的相对链接以嵌套文档为基准，
    # 而文档表渲染在深度不同的仓库 index.md 中，所以摘要保持纯文本。
    return re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", value)


def render_evidence_list(evidence: list[str], doc_abs: Path, workspace: Path) -> str:
    if not evidence:
        return "-"
    rendered: list[str] = []
    for item in evidence:
        if item.startswith("mention_count="):
            rendered.append(f"`{item}`")
            continue
        target = workspace / item
        if target.exists():
            rendered.append(f"[`{item}`]({rel_link(doc_abs, target)})")
        else:
            rendered.append(f"`{item}`")
    return ", ".join(rendered)


def strip_anchor(target: str) -> str:
    return target.split("#", 1)[0]


def is_external_link(target: str) -> bool:
    return bool(re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", target)) or target.startswith("mailto:")


def extract_markdown_links(content: str) -> list[str]:
    return re.findall(r"\[[^\]]+\]\(([^)]+)\)", content)


def extract_markdown_link_pairs(content: str) -> list[tuple[str, str]]:
    """返回 (label, href) 对，供链接标签卫生检查使用。"""
    return re.findall(r"\[([^\]]+)\]\(([^)]+)\)", content)


def ensure_memory_daily_dir(workspace: Path) -> None:
    """幂等创建 daily 短期价值层目录;已有内容绝不覆盖。"""
    daily_dir = workspace / MEMORY_DAILY_PATH
    daily_dir.mkdir(parents=True, exist_ok=True)
    gitkeep = daily_dir / ".gitkeep"
    if not gitkeep.exists():
        gitkeep.write_text("", encoding="utf-8")


def shell(*args: str, cwd: Path | None = None) -> str:
    proc = subprocess.run(
        args,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return ""
    return proc.stdout.strip()
