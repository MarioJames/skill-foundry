#!/usr/bin/env python3
"""对契约文件、路由、证据、链接和业务域覆盖做阻断式校验。

非阻断的内容纪律检查在 validate_hygiene.py。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from core import (
    CONFIG_PATH,
    DISCOVERY_PATH,
    RELATION_INDEX_PATH,
    RELATION_REGISTRY_PATH,
    REPO_DOCS_PATH,
    ROOT_DOC_PATHS,
    WORKSPACE_INDEX_PATH,
    extract_markdown_links,
    is_external_link,
    read_json,
    read_text,
    rel_link,
    strip_anchor,
)
from config import repo_doc_paths
from relations import normalize_standalone_repos, relation_shape_errors
from validate_hygiene import collect_hygiene_warnings

# 某个仓库扫描到的页面分组 / Maven 模块 / workspace 包 / monorepo 应用
# 达到这个数量却没有业务域文档时，校验失败。这说明研究填充阶段把下层图谱留空了。
# 注意口径：这里把 Maven 模块计入子区数，是拿模块数当仓库复杂度代理（模块多的服务
# 必须有业务域文档）；validate_hygiene 的逐子区覆盖检查则不把模块当业务域单位。
# 两者口径不同是有意的。
DOMAIN_COVERAGE_THRESHOLD = 5


def required_paths_from_config(config: dict[str, Any]) -> list[Path]:
    paths = [
        CONFIG_PATH,
        DISCOVERY_PATH,
        RELATION_REGISTRY_PATH,
        RELATION_INDEX_PATH,
        WORKSPACE_INDEX_PATH,
    ]
    paths.extend(ROOT_DOC_PATHS)
    for repo_name in config.get("workspace", {}).get("repo_order", []):
        repo_paths = repo_doc_paths(repo_name)
        paths.append(repo_paths["index"])
    return paths


def generated_markdown_paths(workspace: Path) -> list[Path]:
    markdown_files = [workspace / path for path in ROOT_DOC_PATHS if (workspace / path).exists()]
    workspace_dir = workspace / ".workspace"
    if workspace_dir.exists():
        markdown_files.extend(sorted(workspace_dir.rglob("*.md")))
    return markdown_files


def validate_workspace(workspace: Path) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    config_path = workspace / CONFIG_PATH
    if not config_path.exists():
        return [f"缺少声明层文件：{CONFIG_PATH.as_posix()}"], warnings

    try:
        config = read_json(config_path)
    except json.JSONDecodeError as exc:
        return [
            f"{CONFIG_PATH.as_posix()} 必须使用 JSON 语法（`.yaml` 只是历史遗留的扩展名约定；"
            f"见 references/config-schema.md）：{exc}"
        ], warnings

    if "repos" in config:
        errors.append(
            "根 `.workspace/metadata.yaml` 不能包含遗留的 `repos` 键（自动迁移已移除）。"
            "请手动把仓库声明沉淀到 .workspace/repos/<repo>/ 的 Markdown 事实源，然后删除该键。"
        )
    if "memory_seed" in config:
        errors.append(
            "根 `.workspace/metadata.yaml` 不能包含遗留的 `memory_seed` 键（自动迁移已移除）。"
            "请手动把有用条目搬进 MEMORY.md，然后删除该键。"
        )

    discovery_path = workspace / DISCOVERY_PATH
    if not discovery_path.exists():
        warnings.append(f"缺少自动扫描快照：{DISCOVERY_PATH.as_posix()}")
        discovery = {"repos": []}
    else:
        discovery = read_json(discovery_path)

    for required_path in required_paths_from_config(config):
        if not (workspace / required_path).exists():
            errors.append(f"缺少生成产物：{required_path.as_posix()}")

    claude_path = workspace / "CLAUDE.md"
    if claude_path.exists():
        if read_text(claude_path).strip() != "@AGENTS.md":
            errors.append("CLAUDE.md 必须严格只有一行：`@AGENTS.md`。")

    if config.get("workspace", {}).get("entry_policy", {}).get("delete_workspace_md") and (workspace / "WORKSPACE.md").exists():
        errors.append("配置要求删除 WORKSPACE.md，但根目录下该文件仍然存在。")

    standalone_names = {
        entry["repo"]
        for entry in normalize_standalone_repos(config.get("standalone_repos", []))
    }
    task_routes = config.get("workspace", {}).get("task_routes", [])
    routed_targets: set[str] = set()
    for route in task_routes:
        if not route.get("read"):
            errors.append(
                f"任务路由 `{route.get('name', '?')}` 没有 read 目标；"
                f"请在 .workspace/metadata.yaml 的 task_routes 补充要阅读的文档路径。"
            )
        for target in route.get("read", []):
            routed_targets.add(target)
            target_path = workspace / target
            if not target_path.exists():
                errors.append(f"task_routes 引用了不存在的路径：{target}")
    # 有任务路由后，每个核心仓库都必须被某条路由覆盖。
    # 独立仓库由 AGENTS.md 单独路由，这里豁免。
    if task_routes:
        for repo_name in config.get("workspace", {}).get("repo_order", []):
            if repo_name in standalone_names:
                continue
            repo_prefix = (REPO_DOCS_PATH / repo_name).as_posix() + "/"
            if not any(target.startswith(repo_prefix) for target in routed_targets):
                errors.append(
                    f"核心仓库 `{repo_name}` 未被任何任务路由覆盖；"
                    f"请在 .workspace/metadata.yaml 的 task_routes 补充一条，或声明为独立仓库。"
                )

    relation_repo_names = set(config.get("workspace", {}).get("repo_order", []))
    for entry in normalize_standalone_repos(config.get("standalone_repos", [])):
        if entry["repo"] not in relation_repo_names:
            errors.append(f"独立仓库声明不在 repo_order 中：{entry['repo']}")

    # 声明关系先过最小 schema 检查，再核实证据路径。
    errors.extend(relation_shape_errors(config.get("relations", [])))

    # 声明层证据必须是可打开的工作区相对路径。
    # 省略号、拼写错误和已删除路径会让关系无法核实。
    declared_relations = config.get("relations", [])
    if isinstance(declared_relations, list):
        for relation in declared_relations:
            if not isinstance(relation, dict):
                continue
            for evidence in relation.get("evidence", []):
                if not isinstance(evidence, str) or not evidence:
                    continue
                if not (workspace / evidence).exists():
                    errors.append(
                        f"关系证据路径不存在：{relation.get('from')} -> {relation.get('to')} "
                        f"`{evidence}`。证据必须是真实的工作区相对路径；"
                        f"不要用 `...` 省略路径片段。"
                    )
    for entry in normalize_standalone_repos(config.get("standalone_repos", [])):
        for evidence in entry.get("evidence", []):
            if not isinstance(evidence, str) or not evidence:
                continue
            if not (workspace / evidence).exists():
                errors.append(
                    f"独立仓库证据路径不存在：{entry['repo']} `{evidence}`。"
                    f"证据必须是真实的工作区相对路径；不要用 `...` 省略路径片段。"
                )

    registry_path = workspace / RELATION_REGISTRY_PATH
    if registry_path.exists():
        registry = read_json(registry_path)
        for entry in normalize_standalone_repos(registry.get("standalone_repos", [])):
            if entry["repo"] not in relation_repo_names:
                errors.append(f"registry 独立仓库不在 repo_order 中：{entry['repo']}")
        for relation in registry.get("relations", []):
            source_repo = relation.get("from")
            target_repo = relation.get("to")
            if source_repo not in relation_repo_names:
                errors.append(f"关系起点不在 repo_order 中：{source_repo}")
            if target_repo not in relation_repo_names:
                errors.append(f"关系终点不在 repo_order 中：{target_repo}")
            if not isinstance(source_repo, str) or not isinstance(target_repo, str):
                # 端点缺失已在上方报错；跳过回链检查避免 KeyError。
                continue
            source_index = workspace / REPO_DOCS_PATH / source_repo / "index.md"
            target_index = workspace / REPO_DOCS_PATH / target_repo / "index.md"
            if source_index.exists() and target_index.exists():
                source_expected = rel_link(source_index, target_index)
                target_expected = rel_link(target_index, source_index)
                source_content = read_text(source_index)
                target_content = read_text(target_index)
                if f"[{target_repo}]({source_expected})" not in source_content:
                    errors.append(
                        f"源仓库 index 缺少关系链接：{source_repo} -> {target_repo}"
                    )
                if f"[{source_repo}]({target_expected})" not in target_content:
                    errors.append(
                        f"目标仓库 index 缺少关系回链：{target_repo} -> {source_repo}"
                    )

    markdown_paths = generated_markdown_paths(workspace)
    for markdown_path in markdown_paths:
        content = read_text(markdown_path)
        for raw_target in extract_markdown_links(content):
            target = strip_anchor(raw_target)
            if not target or target.startswith("#") or is_external_link(target):
                continue
            resolved = (markdown_path.parent / target).resolve()
            if not resolved.exists():
                display_path = markdown_path.relative_to(workspace).as_posix()
                errors.append(f"链接失效：{display_path} -> {raw_target}")

    for repo in discovery.get("repos", []):
        repo_name = repo.get("name")
        if not repo_name:
            continue
        # "apps" 只存在于遗留快照；新扫描把应用并入 packages。
        subarea_count = (
            len(repo.get("frontend", {}).get("page_groups", []))
            + len(repo.get("backend", {}).get("modules", []))
            + len(repo.get("monorepo", {}).get("packages", []))
            + len(repo.get("monorepo", {}).get("apps", []))
        )
        domains_dir = workspace / REPO_DOCS_PATH / repo_name / "domains"
        domain_docs = list(domains_dir.glob("*.md")) if domains_dir.exists() else []
        if subarea_count >= DOMAIN_COVERAGE_THRESHOLD and not domain_docs:
            errors.append(
                f"仓库 `{repo_name}` 扫描到 {subarea_count} 个页面/模块/包/应用，"
                f"却没有业务域文档。研究阶段必须在 .workspace/repos/{repo_name}/domains/ 下"
                f"补充业务域事实；standalone 只表示没有已知跨仓关系，不能豁免复杂仓库的业务域入口。"
            )

    warnings.extend(collect_hygiene_warnings(workspace, config, discovery))
    return errors, warnings
