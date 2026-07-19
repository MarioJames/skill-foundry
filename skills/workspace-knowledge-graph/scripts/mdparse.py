#!/usr/bin/env python3
"""Markdown 事实源解析：表格、分节、frontmatter 和命令。

本模块只从文本中提取结构。默认值在 config.py，渲染在 render_*.py。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from core import read_text, strip_anchor

# 面向人的文档渲染中文标签。英文标签保留为遗留别名，
# 让既有生成的工作区刷新时不丢失已沉淀的事实。
SECTION_ALIASES = {
    "Repository Facts": ("仓库事实", "Repository Facts"),
    "Common Operations": ("常用操作", "Common Operations"),
    "Relations": ("关系", "Relations"),
    "Docs": ("文档", "Docs"),
    "Auto Scan Snapshot": ("自动扫描快照", "Auto Scan Snapshot"),
    "Summary": ("摘要", "Summary"),
    "Human Judgment": ("人工判断", "Human Judgment"),
}

FIELD_ALIASES = {
    "Category": ("类别", "Category"),
    "Audience": ("读者", "Audience"),
    "Summary": ("摘要", "Summary"),
    "Role": ("职责", "Role"),
    "Primary Entries": ("主要入口", "Primary Entries"),
}

# 仓库 index.md 中由脚本渲染的分节。其余 `##` 小节属于 agent 撰写内容，
# 刷新时原样保留。
DERIVED_INDEX_SECTIONS = {
    "仓库事实",
    "Repository Facts",
    "常用操作",
    "Common Operations",
    "关系",
    "Relations",
    "文档",
    "Docs",
    "自动扫描快照",
    "Auto Scan Snapshot",
}

# 表格单元格按未转义的 `|` 切分。
TABLE_CELL_SPLIT = re.compile(r"(?<!\\)\|")

# `<runner> run <script>` 和 `<runner> <script>` 是等价的脚本命令拼写。
COMMAND_RUNNER_RUN = re.compile(r"^(tnpm|pnpm|npm|yarn|bun)\s+run\s+")


def alias_values(value: str, aliases: dict[str, tuple[str, ...]]) -> tuple[str, ...]:
    return aliases.get(value, (value,))


def markdown_section(lines: list[str], heading: str) -> list[str]:
    headings = set(alias_values(heading, SECTION_ALIASES))
    start = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("## ") and stripped[3:] in headings:
            start = index + 1
            break
    if start is None:
        return []
    end = len(lines)
    for index in range(start, len(lines)):
        if lines[index].startswith("## "):
            end = index
            break
    return lines[start:end]


def first_paragraph(lines: list[str]) -> str:
    chunks: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            if chunks:
                break
            continue
        if stripped.startswith("#") or stripped.startswith("- "):
            continue
        chunks.append(stripped)
    return " ".join(chunks)


def repo_relative_link(workspace: Path, repo_name: str, doc_abs: Path, target: str) -> str | None:
    target = strip_anchor(target)
    if not target:
        return None
    resolved = (doc_abs.parent / target).resolve()
    repo_root = (workspace / repo_name).resolve()
    try:
        return resolved.relative_to(repo_root).as_posix()
    except ValueError:
        return None


def parse_nested_doc(workspace: Path, doc_path: Path) -> dict[str, Any]:
    """业务域/共享文档只提取文档表需要的 slug 和摘要；正文归 agent 所有，不做结构化解析。"""
    lines = read_text(workspace / doc_path).splitlines()
    return {
        "slug": doc_path.stem,
        "summary": first_paragraph(markdown_section(lines, "Summary")),
    }


def raw_table_value(content: str, key: str) -> str | None:
    for label in alias_values(key, FIELD_ALIASES):
        pattern = re.compile(rf"^\|\s*{re.escape(label)}\s*\|\s*(.*?)\s*\|$", re.MULTILINE)
        match = pattern.search(content)
        if match:
            return match.group(1).strip()
    return None


def table_value(content: str, key: str) -> str | None:
    value = raw_table_value(content, key)
    if value is None:
        return None
    # 2 个及以上反引号的对称外壳是渲染/粘贴事故。反复剥离，
    # 让历史损伤在一次解析中收敛。
    while True:
        match = re.match(r"^(`{2,})(.*)\1$", value, re.DOTALL)
        if not match:
            break
        value = match.group(2).strip()
    # 仅当整个单元格是一个代码值时才剥掉一层代码跨度。
    # 含多个代码跨度的单元格需要按字段专门解析。
    return re.sub(r"^`([^`]*)`$", r"\1", value)


def parse_entry_paths_from_table(workspace: Path, repo_name: str, index_abs: Path, value: str) -> list[str]:
    paths: list[str] = []

    def add(item: str) -> None:
        # 尾部斜杠是同一入口路径的拼写变体。
        normalized = item.strip().rstrip("/")
        if normalized and normalized not in paths:
            paths.append(normalized)

    for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", value):
        repo_path = repo_relative_link(workspace, repo_name, index_abs, target)
        if repo_path:
            add(repo_path)
    # 链接标签常包含代码包裹的路径。先移除链接再扫描裸代码跨度，
    # 避免同一入口被收集两次。
    without_links = re.sub(r"\[[^\]]*\]\([^)]*\)", "", value)
    for raw in re.findall(r"`([^`]+)`", without_links):
        add(raw)
    return paths


def normalize_command_cell(cell: str) -> str:
    """把常用操作的命令单元格归一化成稳定的命令键。

    agent 撰写的变体（`tnpm run dev`、`bash release.sh`、
    `` `command` -> 解释 ``）必须与检测出的命令对齐。
    """
    value = cell.replace("\\|", "|").strip()
    span = re.search(r"`([^`]+)`", value)
    if span:
        # 取第一个代码跨度，丢弃解释性后缀。
        value = span.group(1).strip()
    else:
        value = re.split(r"(?:->|\()", value, maxsplit=1)[0].strip()
    for prefix in ("bash ", "sh ", "./"):
        if value.startswith(prefix):
            value = value[len(prefix) :].strip()
            break
    value = COMMAND_RUNNER_RUN.sub(r"\1 ", value)
    return re.sub(r"\s+", " ", value)


def parse_operation_rows(lines: list[str]) -> list[dict[str, str]]:
    """解析"常用操作"的数据行，保留单元格原始文本。

    畸形行不会被悄悄丢弃：溢出的单元格用转义管道符折回说明列，
    3 列的行补 `-` 证据。表面修复由 validate 卫生警告负责报告。
    """
    rows: list[dict[str, str]] = []
    for line in lines:
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip() for cell in TABLE_CELL_SPLIT.split(stripped.strip("|"))]
        if len(cells) < 3:
            continue
        if cells[0] in {"Scenario", "场景"} or set(cells[0]) <= {"-", " ", ":"}:
            continue
        if len(cells) == 3:
            cells.append("-")
        rows.append(
            {
                "scene": cells[0],
                "command": cells[1],
                "note": "\\|".join(cells[2:-1]),
                "evidence": cells[-1],
            }
        )
    return rows


def parse_agent_index_sections(content: str) -> list[str]:
    """收集 index.md 中的非派生 `##` 小节，供原样保留。"""
    sections: list[tuple[str, list[str]]] = []
    current: tuple[str, list[str]] | None = None
    for line in content.splitlines():
        if line.startswith("## "):
            if current is not None:
                sections.append(current)
            current = (line[3:].strip(), [line])
            continue
        if current is not None:
            current[1].append(line)
    if current is not None:
        sections.append(current)
    preserved: list[str] = []
    for heading, body in sections:
        if heading in DERIVED_INDEX_SECTIONS:
            continue
        text = "\n".join(body).rstrip()
        if text:
            preserved.append(text)
    return preserved
