#!/usr/bin/env python3
"""根级渲染：AGENTS/CLAUDE/MEMORY、拓扑、关系和 bootstrap 骨架。

仓库级文档在 render_repo.py 渲染，整体编排在 render.py。
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from core import (
    CONFIG_PATH,
    DISCOVERY_PATH,
    RELATION_INDEX_PATH,
    RELATION_REGISTRY_PATH,
    REPO_DOCS_PATH,
    WORKSPACE_INDEX_PATH,
    ensure_memory_daily_dir,
    escape_cell,
    rel_link,
    render_category_cell,
    render_evidence_list,
    write_text,
)
from config import bootstrap_config, bootstrap_discovery, bootstrap_relation_registry
from discovery import repo_map
from relations import normalize_standalone_repos

MEMORY_GUIDANCE_IN_MEMORY_V1 = (
    "只保存无法从代码、git/PR/CI、任务系统或 `.workspace/` 事实源可靠恢复，"
    "且会改变后续决策的上下文。使用带日期的 `[偏好]`、`[纠正]`、"
    "`[用户操作]`、`[确认决策]` 或 `[接续]` 条目，写清作用域、来源和当前有效结论；"
    "按 `## workspace` / `## repo:<repo>` 分节，任务再嵌套 `### task:<task-key>`，"
    "不要记录实现清单、测试结果、精确计数或例行图谱刷新，过期或已进入权威事实源的内容应压缩或删除。"
)
MEMORY_PLACEHOLDER = "- 暂无需要保留的上下文。"
MEMORY_PLACEHOLDERS = {
    MEMORY_PLACEHOLDER,
    "- 暂无操作记忆。",
    "- No operation memory yet.",
}
MEMORY_SCOPE_HEADING_RE = re.compile(r"^##\s+(?:workspace|repo:([^\s/]+))\s*$")
MEMORY_TASK_HEADING_RE = re.compile(r"^###\s+task:([A-Za-z0-9][A-Za-z0-9._-]*)\s*$")
MEMORY_LEGACY_HEADING_RE = re.compile(r"(?m)^##\s+\d{4}-\d{2}-\d{2}\b")
MEMORY_DATED_BULLET_RE = re.compile(r"^-\s+`?\d{4}-\d{2}-\d{2}`?(?=\s|[:：])")
LEGACY_MEMORY_GUIDANCE = {
    MEMORY_GUIDANCE_IN_MEMORY_V1,
    "按日期记录真实业务任务和用户补充语境：用户怎么称呼任务对象、最终定位到哪个项目/目录、做了什么、遗留了什么，供后续会话回答“上次做到哪”和“用户这样说时该去哪里”。例行图谱刷新不作为主要记忆。",
    "按日期记录已完成的重要动作：做了什么、动了哪些事实源、遗留了什么，供后续会话回答“上次做到哪”。",
    "记录这个工作区内重要的已完成操作，便于后续回忆。",
    "Records important completed operations in this workspace for later recall.",
}

MEMORY_CONSUMPTION_STEP = (
    "命中时间指称（“昨天/前天/上周/前几天/那次”等）时，先换算为具体日期，"
    "再打开 [.workspace/memory/daily/](.workspace/memory/daily/) 下对应日期的文件（无文件则看相邻日期），"
    "按行内 `repo:` / `workspace` 对象标签定位；需要语境时再按 scope 和任务关键词定位并读取"
    " [MEMORY.md](MEMORY.md) 对应小节，代码细节用 git 兜底。"
    "只有用户提到“上次/继续/之前”、任务明确续接未完成工作、需要恢复用户偏好/纠正/确认取舍/用户操作，"
    "或对象称呼仍有歧义时，才按上述 scope 路径读取 `MEMORY.md` 对应小节；"
    "不要默认读取整个 `MEMORY.md` 或整个 `.workspace/memory/daily/` 目录。"
)
MEMORY_AUTHORITY_LINE = (
    "- `MEMORY.md`: 按需读取的非权威上下文，仅作历史线索；不能覆盖当前用户指令、当前代码/配置、"
    "git/CI 或 `.workspace/` 事实源，也不授权重复执行历史外部操作；再次依赖前先核验当前状态。"
)
MEMORY_BOUNDARY_LINES = [
    "- `MEMORY.md` 与 `.workspace/memory/daily/` 分工：`.workspace/memory/daily/YYYY-MM-DD.md` 承载与某个日期、阶段、当前任务或短期接续相关的有价值信息；`MEMORY.md` 承载会持续影响工作空间或仓库后续行为的长期结论，如用户偏好、纠正、用户完成的外部操作、确认取舍和长期接续约束。",
    "- 收尾时不直接转写本轮事件，先提炼为后续可复用的结论、约束、理由、线索或接续状态；是否写入只有一个判断条件：这条信息对后续工作有没有价值。能否从代码、git/PR/CI、任务系统或图谱事实源恢复，不参与是否写入的判断，只在消费时用于事实核验。",
    "- 价值判断通过后再选择承载层；没有价值就不写，不为满足流程强行创建条目。daily 每条以 `repo:<repo>` 或 `workspace` 对象标签开头，` — ` 分隔后保持单行；一天一个文件，先提炼、全保留、不压缩。",
    "- `MEMORY.md` 按 `## workspace` / `## repo:<repo>` 分节；具体任务嵌套 `### task:<task-key>`。每条使用 `- <日期> [偏好|纠正|用户操作|确认决策|接续] 来源：…；结论：…`。agent 推断不得伪装成用户确认。",
    "- 改动文件清单、完成摘要、测试结果、精确数量或例行 `scan/init/validate` 不因本轮发生过就自动成为记忆；只有先提炼出对后续工作有价值的信息才记录。用户更正后删除、压缩或明确替代旧结论。",
    "- 稳定对象映射、仓库入口、命令、业务事实和跨仓关系应晋升到 `.workspace/metadata.yaml` 或 `.workspace/repos/**`；记忆只保留对后续工作有独立价值的提炼信息。",
    "- 记忆写入与消费规则只放在 `AGENTS.md`；`MEMORY.md` 和 daily 文件只放实际记录，无条目时 `MEMORY.md` 仅保留标题和占位，不复制本节协议。",
]
WRAP_UP_REVIEW_LINES = [
    "- 交付结论前必须完成记忆评估：1） 从本轮对话、决策和实施结果中提取候选信息；"
    "2） 不直接复制事件摘要，先提炼为后续可复用的结论、约束、理由、线索或接续状态；"
    "3） 只以“这条信息对后续工作有没有价值”判断是否写入；"
    "4） 有价值时再按作用范围和有效期选择 daily 或 `MEMORY.md`，没有价值就不写；"
    "5） 评估结论为“无该记内容”时显式说明一句，不强行编造。",
    "- 评估不询问用户：毫无争议该记的内容直接记，无需陈述；有争议或可商榷的内容直接说明记了什么/没记什么及理由，不抛给用户决定。向用户确认“要不要记/记哪条”属于干扰。",
    "- 记忆发生变化时在最终答复中通知用户，只概括重点、不复述完整条目：daily 使用“记忆已新增：<重点>”或“记忆已更新：<重点>”；`MEMORY.md` 使用“工作空间全局记忆已新增：<重点>”或“工作空间全局记忆已更新：<重点>”。daily 与 `MEMORY.md` 同时变化时分别通知。",
]
DAILY_AUTHORITY_LINE = (
    "- `.workspace/memory/daily/`: 按天的短期价值记录，用于时间锚点回溯；"
    "不证明当前状态，再次依赖前先核验。"
)
SOURCE_AUTHORITY_LINES = [
    "- 当前用户指令，以及当前代码、配置、外部实时状态、git/PR/CI 证据：最高权威。",
    "- `AGENTS.md`: 生成的根路由、消费门禁与维护规则，不是持久事实源。",
    "- `.workspace/metadata.yaml`: 工作区级持久事实源。",
    "- `.workspace/relations/registry.yaml`: 由声明和扫描编译出的跨仓关系视图，不要手改。",
    "- `.workspace/repos/<repo>/index.md`: 仓库级事实源。",
    "- `.workspace/repos/<repo>/domains/*.md`: 业务域事实源。",
    "- `.workspace/repos/<repo>/shared/*.md`: 共享或平台机制事实源。",
    MEMORY_AUTHORITY_LINE,
    DAILY_AUTHORITY_LINE,
    "- `.workspace/state/discovery.json`: 自动扫描快照，只用于排障或审计。",
]


def render_bootstrap_agents(workspace_name: str) -> str:
    title = f"# {workspace_name} Agent 入口"
    return "\n".join(
        [
            title,
            "",
            "## 阅读顺序",
            "",
            "1. 先读本文件，确认根路由和权威顺序。",
            "2. 阅读 [.workspace/metadata.yaml](.workspace/metadata.yaml) 和 [.workspace/index.md](.workspace/index.md)。",
            f"3. {MEMORY_CONSUMPTION_STEP}",
            "4. 初始化后扫描仓库、补齐第一批事实源，再生成可用图谱。",
            "",
            "## 权威顺序",
            "",
            *SOURCE_AUTHORITY_LINES,
            "",
            "## 记忆边界",
            "",
            *MEMORY_BOUNDARY_LINES,
            "- 用户首次提供的稳定对象称呼、项目归属和目录映射，要补进任务路由、仓库 index、业务域或共享文档；无法消歧或缺少证据时不要硬写，先标为阻断或待用户确认。",
            "",
            "## 收尾记忆评估",
            "",
            *WRAP_UP_REVIEW_LINES,
            "",
            "## 多仓关联维护",
            "",
            "- `AGENTS.md` 只存放每个工作区入口都必须消费的阅读顺序、路由、权威顺序和维护原则；不要放具体仓库细节。",
            "- 任务发现稳定可复用的单仓事实，或首次从用户说法补全任务对象到项目/目录的映射时，写入 `.workspace/repos/<repo>/index.md`、`domains/` 或 `shared/`。",
            "- 任务发现稳定可复用的多仓关系、契约面、双侧证据、任务路由或仓库边界时，写入 `.workspace/metadata.yaml`，再运行 `init` + `validate`。",
            "- 多仓事实要说明方向、连接机制、契约面和关键证据。不要存放完整接口清单、字段级契约、临时排障记录或低密度目录盘点。",
            "",
            "## 任务路由",
            "",
            "- TODO: 基于仓库扫描结果补充稳定任务路由。",
            "",
            "## 约束",
            "",
            "- 根入口文档只保留 `AGENTS.md`。",
            "- `CLAUDE.md` 必须严格只有一行：`@AGENTS.md`。",
            "- 图谱是持续维护的资产。初始化创建可用入口；后续任务补充稳定事实并重新运行 `init` + `validate`。",
            "- `AGENTS.md` 是生成产物。要修改路由、关系或仓库顺序，先改 `.workspace/metadata.yaml`，再重新运行 `init`。",
        ]
    )


def render_bootstrap_memory() -> str:
    return "\n".join(
        [
            "# 工作区记忆",
            "",
            "## workspace",
            "",
            MEMORY_PLACEHOLDER,
        ]
    )


def normalize_memory_document(content: str) -> str:
    """移除已知生成规则并升级占位，保留自定义前言和所有真实条目。"""
    lines = content.splitlines()
    changed = False
    in_preamble = True
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("## ") or MEMORY_DATED_BULLET_RE.match(stripped):
            in_preamble = False
        if not in_preamble:
            continue
        if stripped in LEGACY_MEMORY_GUIDANCE:
            lines[idx] = ""
            changed = True
        elif stripped in MEMORY_PLACEHOLDERS and stripped != MEMORY_PLACEHOLDER:
            lines[idx] = MEMORY_PLACEHOLDER
            changed = True
    if not changed:
        return content
    suffix = "\n" if content.endswith("\n") else ""
    normalized = re.sub(r"\n{3,}", "\n\n", "\n".join(lines))
    return normalized.rstrip() + suffix


def memory_candidate_lines(content: str) -> list[str]:
    """返回 scope 内的记忆列表项和可识别的旧式日期列表项。"""
    candidates: list[str] = []
    parent_scope: str | None = None
    current_scope: str | None = None
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if line.startswith("## "):
            scope_match = MEMORY_SCOPE_HEADING_RE.match(line)
            parent_scope = line[3:].strip() if scope_match else None
            current_scope = parent_scope
            continue
        if line.startswith("### "):
            task_match = MEMORY_TASK_HEADING_RE.match(line)
            current_scope = (
                f"{parent_scope}/task:{task_match.group(1)}"
                if task_match and parent_scope is not None
                else None
            )
            continue
        if not line.startswith("-") or line in MEMORY_PLACEHOLDERS:
            continue
        if current_scope is not None or MEMORY_DATED_BULLET_RE.match(line):
            candidates.append(line)
    return candidates


def strip_memory_placeholder(content: str) -> str:
    """MEMORY.md 有了真实内容后移除 bootstrap 占位。

    scope 内的列表项（即使格式待校正）或可识别的旧式日期条目算真实内容；
    注释、自定义说明和空 scope 不会误撤占位，格式问题由 validate 告警。
    """
    if not any(placeholder in content for placeholder in MEMORY_PLACEHOLDERS):
        return content
    has_substance = bool(memory_candidate_lines(content) or MEMORY_LEGACY_HEADING_RE.search(content))
    if not has_substance:
        return content
    kept = [line for line in content.splitlines() if line.strip() not in MEMORY_PLACEHOLDERS]
    collapsed = re.sub(r"\n{3,}", "\n\n", "\n".join(kept))
    return collapsed.rstrip() + "\n"


def render_bootstrap_workspace_index() -> str:
    return "\n".join(
        [
            "# 工作区拓扑",
            "",
            "- 当前只初始化了骨架。",
            "- 下一步扫描同级仓库、补齐第一批事实源，然后重新渲染可用图谱。",
        ]
    )


def render_bootstrap_relation_index() -> str:
    return "\n".join(
        [
            "# 工作区关系",
            "",
            "- 当前只初始化了骨架。关系摘要等待 agent 研究后补充。",
        ]
    )


def render_claude() -> str:
    return "@AGENTS.md"


def has_suppressed_relations(config: dict[str, Any]) -> bool:
    return bool(config.get("suppressed_relations") or config.get("suppressed_relation_types"))


def render_suppression_notes(config: dict[str, Any]) -> list[str]:
    notes: list[str] = []
    for relation in config.get("suppressed_relations", []):
        if {"from", "to", "type"} <= set(relation.keys()):
            notes.append(f"- `{relation['from']} -> {relation['to']}` (`{relation['type']}`)")
    for relation_type in config.get("suppressed_relation_types", []):
        notes.append(f"- 类型 `{relation_type}`")
    return notes


def render_agents(workspace: Path, config: dict[str, Any], discovery: dict[str, Any]) -> str:
    task_routes = config["workspace"].get("task_routes", [])
    route_lines = []
    for route in task_routes:
        reads = ", ".join(f"[{item}]({item})" for item in route.get("read", []))
        # 中英文句号都要剥掉，避免补句号后出现"。。"。
        when = route["when"].rstrip(".。")
        line = f"- `{route['name']}`: {when}。"
        if reads:
            line += f"优先阅读：{reads}"
        route_lines.append(line)
    standalone_entries = normalize_standalone_repos(config.get("standalone_repos", []))
    if standalone_entries:
        # 兜底路由只补空缺。已被任务路由阅读列表覆盖的独立仓库不再重复注入。
        routed_reads = {read for route in task_routes for read in route.get("read", [])}
        unrouted_entries = [
            entry
            for entry in standalone_entries
            if not any(
                read.startswith(f".workspace/repos/{entry['repo']}/") for read in routed_reads
            )
        ]
        if unrouted_entries:
            links = ", ".join(
                f"[{entry['repo']}](.workspace/repos/{entry['repo']}/index.md)"
                for entry in unrouted_entries
            )
            route_lines.append(
                f"- `独立仓库`: 涉及 {links} 这类独立交付仓库时，直接阅读对应 index.md"
                "（没有已知核心链路依赖，不属于跨仓集成）。"
            )
    if not route_lines:
        route_lines.append("- `待补充`: 在 `.workspace/metadata.yaml` 的 `task_routes` 下补充稳定路由。")
    constraint_lines = [
        "- 根入口只保留 `AGENTS.md`；不要维护 `WORKSPACE.md`。",
        "- 跨仓关系保持仓库级粒度；更深细节放到 `.workspace/repos/` 下。",
        "- 没有依赖证据的仓库放入 `.workspace/metadata.yaml` 的 `standalone_repos`；不要用弱 peer 关系代替。",
        "- 图谱是持续维护的资产。搜索、调试或集成工作发现稳定可复用事实时，修补最小且正确的事实源，并重新运行 `init` + `validate`。",
    ]
    if has_suppressed_relations(config):
        constraint_lines.append(
            "- 部分自动检测关系会通过 `.workspace/metadata.yaml` 的 `suppressed_relations` / `suppressed_relation_types` 过滤；说明见 `.workspace/relations/index.md`。"
        )
    constraint_lines.append(
        "- `AGENTS.md` 是生成产物。要修改路由、关系或仓库顺序，先改 `.workspace/metadata.yaml`，再重新运行 `init`。"
    )
    return "\n".join(
        [
            f"# {config['workspace']['name']} Agent 入口",
            "",
            "## 阅读顺序",
            "",
            "1. 先读本文件，确认根路由、任务路由和权威顺序。",
            "2. 命中下方任务路由后，直接阅读对应的 `.workspace/repos/<repo>/index.md`。",
            f"3. {MEMORY_CONSUMPTION_STEP}",
            "4. 处理跨仓关系时，先读 [.workspace/relations/index.md](.workspace/relations/index.md)。做全局拓扑或结构化审计时，再读 [.workspace/index.md](.workspace/index.md) 和 [.workspace/relations/registry.yaml](.workspace/relations/registry.yaml)。",
            "",
            "## 权威顺序",
            "",
            *SOURCE_AUTHORITY_LINES,
            "",
            "## 记忆边界",
            "",
            *MEMORY_BOUNDARY_LINES,
            "- 用户首次提供的稳定对象称呼、项目归属和目录映射，要补进任务路由、仓库 index、业务域或共享文档；无法消歧或缺少证据时不要硬写，先标为阻断或待用户确认。",
            "",
            "## 收尾记忆评估",
            "",
            *WRAP_UP_REVIEW_LINES,
            "",
            "## 多仓关联维护",
            "",
            "- `AGENTS.md` 只存放每个工作区入口都必须消费的阅读顺序、路由、权威顺序和维护原则；不要放具体仓库细节。",
            "- 任务发现稳定可复用的单仓事实，或首次从用户说法补全任务对象到项目/目录的映射时，写入 `.workspace/repos/<repo>/index.md`、`domains/` 或 `shared/`。",
            "- 任务发现稳定可复用的多仓关系、契约面、双侧证据、任务路由或仓库边界时，写入 `.workspace/metadata.yaml`，再运行 `init` + `validate`。",
            "- 多仓事实要说明方向、连接机制、契约面和关键证据。不要存放完整接口清单、字段级契约、临时排障记录或低密度目录盘点。",
            "",
            "## 任务路由",
            "",
            *route_lines,
            "",
            "## 约束",
            "",
            *constraint_lines,
        ]
    )


def render_standalone_repo_section(
    workspace: Path,
    doc_abs: Path,
    config: dict[str, Any],
) -> list[str]:
    entries = normalize_standalone_repos(config.get("standalone_repos", []))
    if not entries:
        return []
    lines = [
        "",
        "## 独立仓库",
        "",
        "这些仓库不在 `relations` 边集合中。只有找到具体依赖、调用或共享制品证据后，才升级为关系边。",
        "",
        "| 仓库 | 边界 | 证据 |",
        "| --- | --- | --- |",
    ]
    for entry in entries:
        repo = entry["repo"]
        repo_doc = workspace / REPO_DOCS_PATH / repo / "index.md"
        if repo_doc.exists():
            repo_cell = f"[{repo}]({rel_link(doc_abs, repo_doc)})"
        else:
            repo_cell = f"`{repo}`"
        boundary = entry.get("reason") or entry.get("summary") or "声明为独立仓库。"
        evidence = render_evidence_list(entry.get("evidence", []), doc_abs, workspace)
        lines.append(f"| {repo_cell} | {escape_cell(boundary)} | {evidence} |")
    return lines


def render_workspace_index(
    workspace: Path,
    config: dict[str, Any],
    repo_models: dict[str, dict[str, Any]],
    discovery: dict[str, Any],
) -> str:
    by_name = repo_map(discovery)
    workspace_index_abs = workspace / WORKSPACE_INDEX_PATH
    lines = [
        "# 工作区拓扑",
        "",
        "## 概览",
        "",
        f"- 名称：`{config['workspace']['name']}`",
        f"- 定位：{config['workspace'].get('positioning', '')}",
        f"- 自动扫描时间：`{discovery['generated_at']}`",
        "",
        "## 仓库矩阵",
        "",
        "| 仓库 | 类别 | 读者 | 职责 | 入口 |",
        "| --- | --- | --- | --- | --- |",
    ]
    for repo_name in config["workspace"].get("repo_order", []):
        repo_model = repo_models.get(repo_name, {})
        repo_scan = by_name.get(repo_name, {})
        repo_doc = Path(".workspace/repos") / repo_name / "index.md"
        repo_doc_abs = workspace / repo_doc
        entry = ", ".join(f"`{item}`" for item in repo_model.get("primary_entry_paths", [])[:3]) or "-"
        lines.append(
            f"| [{repo_name}]({rel_link(workspace_index_abs, repo_doc_abs)}) | {render_category_cell(repo_model.get('category', repo_scan.get('detected_kind', 'unknown')))} | "
            f"{escape_cell(repo_model.get('audience', 'unknown'))} | {escape_cell(repo_model.get('role', ''))} | {entry} |"
        )
    lines.extend(render_standalone_repo_section(workspace, workspace_index_abs, config))
    lines.extend(
        [
            "",
            "## 关系和审计入口",
            "",
            f"- 工作区级事实源：[.workspace/metadata.yaml]({rel_link(workspace_index_abs, workspace / CONFIG_PATH)})",
            f"- 派生关系视图，不要手改：[{RELATION_REGISTRY_PATH.as_posix()}]({rel_link(workspace_index_abs, workspace / RELATION_REGISTRY_PATH)})",
            f"- 可读关系摘要：[{RELATION_INDEX_PATH.as_posix()}]({rel_link(workspace_index_abs, workspace / RELATION_INDEX_PATH)})",
            f"- 自动扫描快照：[{DISCOVERY_PATH.as_posix()}]({rel_link(workspace_index_abs, workspace / DISCOVERY_PATH)})，只用于排障或审计。",
        ]
    )
    return "\n".join(lines)


def render_relation_registry(
    config: dict[str, Any],
    discovery: dict[str, Any],
    relations: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "generated_at": discovery["generated_at"],
        "workspace": config["workspace"]["name"],
        "repo_order": config["workspace"].get("repo_order", []),
        "relations": relations,
        "standalone_repos": normalize_standalone_repos(config.get("standalone_repos", [])),
    }


def render_relation_index(
    relations: list[dict[str, Any]],
    standalone_repos: list[dict[str, Any]] | None = None,
    config: dict[str, Any] | None = None,
) -> str:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for relation in relations:
        grouped[relation["type"]].append(relation)
    lines = [
        "# 工作区关系",
        "",
        "结构化权威源是 `registry.yaml`；本页是可读摘要。",
        "",
    ]
    for relation_type in sorted(grouped):
        lines.append(f"## {relation_type}")
        lines.append("")
        for relation in grouped[relation_type]:
            arrow = "<->" if relation.get("direction") == "peer" else "->"
            lines.append(
                f"- `{relation['from']}` {arrow} `{relation['to']}`: {relation.get('summary', '')}"
            )
        lines.append("")
    standalone_entries = normalize_standalone_repos(standalone_repos or [])
    if standalone_entries:
        lines.append("## 独立仓库")
        lines.append("")
        lines.append(
            "以下仓库声明为没有仓库级依赖边。不要只因为类别相似就改成 peer 关系。"
            "边界详情和证据在 [.workspace/index.md](../index.md) 的独立仓库表中。"
        )
        lines.append("")
        for entry in standalone_entries:
            brief = entry.get("summary") or entry.get("reason") or "声明为独立仓库。"
            lines.append(f"- `{entry['repo']}`: {brief}")
        lines.append("")
    if config and has_suppressed_relations(config):
        lines.append("## 抑制说明")
        lines.append("")
        lines.append("以下自动检测关系通过 `.workspace/metadata.yaml` 的 `suppressed_relations` / `suppressed_relation_types` 过滤，未进入当前关系图。")
        lines.append("")
        notes = render_suppression_notes(config)
        if notes:
            lines.extend(notes)
        else:
            lines.append("- 已配置抑制规则。")
        lines.append("")
    return "\n".join(lines)


def bootstrap_workspace(workspace: Path) -> None:
    """只补缺失文件。metadata.yaml 与 MEMORY.md 归 agent 所有，任何路径都不得覆盖既有内容。"""
    files_to_write: dict[Path, str] = {
        Path("AGENTS.md"): render_bootstrap_agents(workspace.name),
        Path("CLAUDE.md"): render_claude(),
        Path("MEMORY.md"): render_bootstrap_memory(),
        CONFIG_PATH: json.dumps(bootstrap_config(workspace.name), ensure_ascii=False, indent=2),
        WORKSPACE_INDEX_PATH: render_bootstrap_workspace_index(),
        DISCOVERY_PATH: json.dumps(bootstrap_discovery(workspace), ensure_ascii=False, indent=2),
        RELATION_REGISTRY_PATH: json.dumps(
            bootstrap_relation_registry(workspace.name), ensure_ascii=False, indent=2
        ),
        RELATION_INDEX_PATH: render_bootstrap_relation_index(),
    }
    for rel_path, content in files_to_write.items():
        abs_path = workspace / rel_path
        if not abs_path.exists():
            write_text(abs_path, content)
    (workspace / REPO_DOCS_PATH).mkdir(parents=True, exist_ok=True)
    ensure_memory_daily_dir(workspace)
