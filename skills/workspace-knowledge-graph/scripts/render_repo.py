#!/usr/bin/env python3
"""仓库级渲染：仓库 index、关系/文档表和扫描快照。

根文档与关系视图在 render_root.py 渲染，整体编排在 render.py。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from core import (
    DISCOVERY_PATH,
    RELATION_REGISTRY_PATH,
    REPO_DOCS_PATH,
    escape_cell,
    rel_link,
    render_category_cell,
    render_evidence_list,
    strip_inline_links,
    unescape_cell,
    write_text,
)
from config import repo_doc_paths
from discovery import repo_map
from mdparse import normalize_command_cell


def package_scripts(repo_scan: dict[str, Any]) -> dict[str, str]:
    scripts = repo_scan.get("package", {}).get("script_commands", {})
    if isinstance(scripts, dict):
        return {str(key): str(value) for key, value in scripts.items()}
    return {}


def script_runner(repo_scan: dict[str, Any]) -> str:
    package_manager = str(repo_scan.get("package_manager", "tnpm"))
    # 与 mdparse.COMMAND_RUNNER_RUN 的运行器集合保持一致；
    # tnpm 只是没有任何包管理器信号时的组织默认。
    for runner in ("pnpm", "yarn", "bun", "npm"):
        if package_manager.startswith(runner):
            return runner
    return "tnpm"


def operation_entries(repo_name: str, repo_scan: dict[str, Any], workspace: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    scripts = package_scripts(repo_scan)
    runner = script_runner(repo_scan)
    repo_root = workspace / repo_name

    def add_script(name: str, scene: str, note: str) -> None:
        if name not in scripts:
            return
        entries.append(
            {
                "scene": scene,
                "command": f"{runner} {name}",
                "note": note,
                "evidence": [f"{repo_name}/package.json"],
            }
        )

    if "devs" in scripts:
        if "MOCK=none" in scripts["devs"]:
            if repo_scan.get("detected_kind") == "bigfish-console":
                note = "Bigfish 开发模式带 MOCK=none；用于关闭 mock 并连接真实 API。"
            else:
                note = "脚本包含 MOCK=none；用于关闭 mock 或直接联调。"
        else:
            note = "package.json 暴露的联调开发入口。"
        add_script("devs", "API 联调", note)
    # build / lint / test 是脚手架标准命令，agent 自己读 package.json 就能知道。
    # 常用操作只保留有非平凡语义的条目。
    add_script("test:journey", "旅程测试", "仓库提供的旅程验证入口。")

    if repo_scan.get("detected_kind") == "maven-service":
        entries.append(
            {
                "scene": "构建工具",
                "command": "mvn test / mvn package",
                "note": "Maven 服务；使用 pom.xml 和模块 pom，不要运行 tnpm。",
                "evidence": [f"{repo_name}/pom.xml"],
            }
        )

    if (repo_root / "build.sh").exists():
        entries.append(
            {
                "scene": "构建",
                "command": "./build.sh",
                "note": "该 shell 脚本是仓库构建入口。",
                "evidence": [f"{repo_name}/build.sh"],
            }
        )
    if (repo_root / "release.sh").exists():
        entries.append(
            {
                "scene": "发布",
                "command": "./release.sh",
                "note": "该 shell 脚本是仓库发布入口。",
                "evidence": [f"{repo_name}/release.sh"],
            }
        )
    return entries


def render_repo_path_list(workspace: Path, index_abs: Path, repo_name: str, paths: list[str]) -> str:
    if not paths:
        return "-"
    repo_root = workspace / repo_name
    rendered: list[str] = []
    for item in paths:
        target = repo_root / item
        if target.exists():
            rendered.append(f"[`{item}`]({rel_link(index_abs, target)})")
        else:
            rendered.append(f"`{item}`")
    return ", ".join(rendered)


# operation_entries 可能生成的全部说明文案。此集合要与上方字符串字面量保持同步。
# 说明与之完全一致、且机械命令已不存在的行，视为过期的生成行。
# agent 改写过的行不会匹配，作为 agent 事实保留。
MECHANICAL_OPERATION_NOTES = {
    "package.json 暴露的默认开发入口。",
    "Bigfish 开发模式带 MOCK=none；用于关闭 mock 并连接真实 API。",
    "脚本包含 MOCK=none；用于关闭 mock 或直接联调。",
    "package.json 暴露的联调开发入口。",
    "仓库提供的旅程验证入口。",
    "仓库提供的 OneAPI/mock 测试入口。",
    "仓库提供的 mock 初始化入口。",
    "仓库提供的 mock 同步入口。",
    "Maven 服务；使用 pom.xml 和模块 pom，不要运行 tnpm。",
    "该 shell 脚本是仓库构建入口。",
    "该 shell 脚本是仓库发布入口。",
    "该仓库声明了 pnpm workspace。",
    "Default development entry exposed by package.json.",
    "Bigfish dev with MOCK=none; use it to disable mock and connect to real APIs.",
    "Script includes MOCK=none; use it to disable mock or connect directly for integration.",
    "Integration development entry exposed by package.json.",
    "Repository-provided journey validation entry.",
    "Repository-provided OneAPI/mock test entry.",
    "Repository-provided mock initialization entry.",
    "Repository-provided mock synchronization entry.",
    "Maven service; use pom.xml and module poms. Do not run tnpm.",
    "Shell script is the repository build entry.",
    "Shell script is the repository release entry.",
    "This repository declares a pnpm workspace.",
}


def render_operation_row(row: dict[str, str]) -> str:
    return f"| {row['scene']} | {row['command']} | {row['note']} | {row['evidence']} |"


def render_operation_section(
    workspace: Path,
    index_abs: Path,
    repo_name: str,
    repo_scan: dict[str, Any],
    repo_model: dict[str, Any],
) -> list[str]:
    entries = operation_entries(repo_name, repo_scan, workspace)
    # 机械命令同样要归一化：`./release.sh` 和 `bash release.sh` 必须共享一个键。
    mechanical_by_command = {normalize_command_cell(entry["command"]): entry for entry in entries}

    # 既有行按归一化命令分流：
    # 改过的机械行是 agent 覆盖；没改的机械行重新生成；
    # 过期的生成行丢弃；agent 新增的行保留。
    overrides: dict[str, dict[str, str]] = {}
    extra_rows: list[dict[str, str]] = []
    extra_commands: set[str] = set()
    for row in repo_model.get("operation_rows", []):
        command = normalize_command_cell(row["command"])
        mechanical = mechanical_by_command.get(command)
        row_note = unescape_cell(row["note"])
        if mechanical is not None:
            if (
                unescape_cell(row["scene"]) == mechanical["scene"]
                and row_note == mechanical["note"]
            ):
                continue
            if row_note in MECHANICAL_OPERATION_NOTES:
                continue
            overrides.setdefault(command, row)
            continue
        if row_note in MECHANICAL_OPERATION_NOTES:
            continue
        if command not in extra_commands:
            extra_commands.add(command)
            extra_rows.append(row)

    if not entries and not extra_rows:
        return ["- 暂无自动检测到的常用操作；需要时可从 README、package.json 或 pom.xml 补充。"]

    lines = [
        "| 场景 | 命令/入口 | 说明 | 证据 |",
        "| --- | --- | --- | --- |",
    ]
    for entry in entries:
        override = overrides.get(normalize_command_cell(entry["command"]))
        if override is not None:
            lines.append(render_operation_row(override))
            continue
        evidence = render_evidence_list(entry.get("evidence", []), index_abs, workspace)
        lines.append(
            f"| {escape_cell(entry['scene'])} | `{escape_cell(entry['command'])}` | {escape_cell(entry['note'])} | {evidence} |"
        )
    for row in extra_rows:
        lines.append(render_operation_row(row))
    return lines


def relation_bucket_for_repo(
    repo_name: str,
    relations: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    bucket = {"outbound": [], "inbound": [], "peer": []}
    for relation in relations:
        if relation.get("direction") == "peer":
            if repo_name in {relation["from"], relation["to"]}:
                bucket["peer"].append(relation)
            continue
        if relation["from"] == repo_name:
            bucket["outbound"].append(relation)
        elif relation["to"] == repo_name:
            bucket["inbound"].append(relation)
    return bucket


def render_relation_lines(
    workspace: Path,
    index_abs: Path,
    repo_name: str,
    relations: list[dict[str, Any]],
) -> list[str]:
    bucket = relation_bucket_for_repo(repo_name, relations)
    rows: list[tuple[str, dict[str, Any]]] = []
    for label, items in [
        ("Outbound", bucket["outbound"]),
        ("Inbound", bucket["inbound"]),
        ("Peer", bucket["peer"]),
    ]:
        for relation in items:
            rows.append((label, relation))
    if not rows:
        return ["- 暂无编译出的仓库级关系。"]
    registry_link = rel_link(index_abs, workspace / RELATION_REGISTRY_PATH)
    lines = [
        "| 方向 | 仓库 | 类型 | 来源 |",
        "| --- | --- | --- | --- |",
    ]
    for label, relation in rows:
        other = relation["to"] if relation["from"] == repo_name else relation["from"]
        other_doc = REPO_DOCS_PATH / other / "index.md"
        rendered_label = {"Outbound": "出站", "Inbound": "入站", "Peer": "双向"}.get(label, label)
        lines.append(
            f"| {rendered_label} | [{other}]({rel_link(index_abs, workspace / other_doc)}) | `{relation['type']}` | [registry.yaml]({registry_link}) |"
        )
    return lines


def render_doc_table(
    workspace: Path,
    index_abs: Path,
    repo_name: str,
    folder: str,
    docs: list[dict[str, Any]],
) -> list[str]:
    if not docs:
        if folder == "domains":
            return ["- 暂无业务域文档；需要时按业务域补充。"]
        return ["- 暂无共享或平台文档。"]
    paths = repo_doc_paths(repo_name)
    lines = [
        "| 文档 | 摘要 |",
        "| --- | --- |",
    ]
    for item in docs:
        target = paths[folder] / f"{item['slug']}.md"
        # 标签固定用文件 slug：文件名才是稳定的主题标识。
        # frontmatter 的 title 是自由文案，不应改变表格标识。
        lines.append(
            f"| [{item['slug']}]({rel_link(index_abs, workspace / target)}) | {escape_cell(strip_inline_links(item.get('summary', ''))) or '-'} |"
        )
    return lines


def render_snapshot_lines(
    workspace: Path,
    index_abs: Path,
    repo_scan: dict[str, Any],
) -> list[str]:
    discovery_link = rel_link(index_abs, workspace / DISCOVERY_PATH)

    def summarize_items(label: str, items: list[str], threshold: int = 5) -> str:
        if len(items) <= threshold:
            values = ", ".join(f"`{item}`" for item in items)
            return f"- {label}：{values}"
        return f"- {label}：`{len(items)}` 项；完整自动扫描见 [{DISCOVERY_PATH.as_posix()}]({discovery_link})。"

    snapshot_lines = [
        f"- 检测类型：`{repo_scan.get('detected_kind', 'unknown')}`",
        f"- 包管理器 / 构建工具：`{repo_scan.get('package_manager', 'unknown')}`",
    ]
    if repo_scan.get("remote"):
        snapshot_lines.append(f"- 远端：`{repo_scan['remote']}`")
    if repo_scan.get("frontend", {}).get("page_groups"):
        page_count = len(repo_scan["frontend"]["page_groups"])
        snapshot_lines.append(
            f"- 页面分组：`{page_count}` 项。优先阅读上方业务域文档；完整自动扫描见 [{DISCOVERY_PATH.as_posix()}]({discovery_link})。"
        )
    if repo_scan.get("frontend", {}).get("service_targets"):
        snapshot_lines.append(summarize_items("服务目标", repo_scan["frontend"]["service_targets"]))
    if repo_scan.get("backend", {}).get("modules"):
        snapshot_lines.append(summarize_items("Maven 模块", repo_scan["backend"]["modules"]))
    if repo_scan.get("monorepo", {}).get("packages"):
        snapshot_lines.append(summarize_items("Workspace 包", repo_scan["monorepo"]["packages"]))
    # "apps" 只存在于遗留快照；新扫描把应用并入 packages。
    if repo_scan.get("monorepo", {}).get("apps"):
        snapshot_lines.append(summarize_items("Monorepo 应用", repo_scan["monorepo"]["apps"]))
    return snapshot_lines


def render_repo_index(
    workspace: Path,
    repo_name: str,
    repo_model: dict[str, Any],
    repo_scan: dict[str, Any],
    relations: list[dict[str, Any]],
) -> str:
    paths = repo_doc_paths(repo_name)
    index_abs = workspace / paths["index"]
    # agent 撰写的非派生小节保留在文档表之后、扫描快照之前。
    agent_section_lines: list[str] = []
    for section in repo_model.get("agent_sections", []):
        agent_section_lines.extend(["", section])
    return "\n".join(
        [
            f"# {repo_name}",
            "",
            "## 仓库事实",
            "",
            "| 字段 | 内容 |",
            "| --- | --- |",
            f"| 类别 | {render_category_cell(repo_model.get('category', repo_scan.get('detected_kind', 'unknown')))} |",
            f"| 读者 | {escape_cell(repo_model.get('audience', 'unknown'))} |",
            f"| 摘要 | {escape_cell(repo_model.get('summary', ''))} |",
            f"| 职责 | {escape_cell(repo_model.get('role', ''))} |",
            f"| 主要入口 | {render_repo_path_list(workspace, index_abs, repo_name, repo_model.get('primary_entry_paths', []))} |",
            "",
            "## 常用操作",
            "",
            *render_operation_section(workspace, index_abs, repo_name, repo_scan, repo_model),
            "",
            "## 关系",
            "",
            *render_relation_lines(workspace, index_abs, repo_name, relations),
            "",
            "## 文档",
            "",
            "- 本页是持久的仓库级事实源。业务域和共享机制细节放在下方文档中。",
            "",
            "### 业务域",
            "",
            *render_doc_table(workspace, index_abs, repo_name, "domains", repo_model.get("domains", [])),
            "",
            "### 共享与平台",
            "",
            *render_doc_table(workspace, index_abs, repo_name, "shared", repo_model.get("shared_docs", [])),
            *agent_section_lines,
            "",
            "## 自动扫描快照",
            "",
            *render_snapshot_lines(workspace, index_abs, repo_scan),
        ]
    )


def render_all_repo_docs(
    workspace: Path,
    config: dict[str, Any],
    repo_models: dict[str, dict[str, Any]],
    discovery: dict[str, Any],
    relations: list[dict[str, Any]],
) -> None:
    by_name = repo_map(discovery)
    for repo_name in config["workspace"].get("repo_order", []):
        repo_model = repo_models.get(repo_name, {})
        repo_scan = by_name.get(repo_name, {"name": repo_name})
        paths = repo_doc_paths(repo_name)
        (workspace / paths["domains"]).mkdir(parents=True, exist_ok=True)
        (workspace / paths["shared"]).mkdir(parents=True, exist_ok=True)
        # 业务域/共享文档归 agent 所有：init 只读取它们刷新文档表，
        # 绝不创建、覆盖或删除。
        write_text(
            workspace / paths["index"],
            render_repo_index(workspace, repo_name, repo_model, repo_scan, relations),
        )
