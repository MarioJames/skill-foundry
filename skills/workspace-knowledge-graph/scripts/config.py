#!/usr/bin/env python3
"""声明层：metadata.yaml 默认结构、仓库模型默认值，以及既有事实的组装。

Markdown 解析在 mdparse.py，渲染在 render_*.py。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from core import CONFIG_PATH, REPO_DOCS_PATH, read_json, read_text, write_json
from discovery import repo_map
from mdparse import (
    markdown_section,
    parse_agent_index_sections,
    parse_entry_paths_from_table,
    parse_nested_doc,
    parse_operation_rows,
    raw_table_value,
    table_value,
)
from relations import auto_relations

# 遗留声明键。自动迁移已移除；init 直接拒绝它们，而不是悄悄丢弃声明。
# validate 也会报告同样的状态。
LEGACY_CONFIG_KEYS = ("repos", "memory_seed")


def default_root_config(discovery: dict[str, Any]) -> dict[str, Any]:
    repo_order = [repo["name"] for repo in discovery["repos"]]
    return {
        "workspace": {
            "name": discovery["workspace"]["name"],
            "summary": "TODO: 补充工作区摘要。",
            "positioning": "TODO: 补充工作区定位。",
            # entry_policy 只保留有消费方的键；根入口/记忆文件名是固定契约，不做配置。
            "entry_policy": {
                "delete_workspace_md": True,
            },
            "repo_order": repo_order,
            "task_routes": [],
        },
        "relations": auto_relations(discovery),
        "standalone_repos": [],
        "suppressed_relations": [],
    }


def load_or_create_root_config(workspace: Path, discovery: dict[str, Any]) -> dict[str, Any]:
    config_path = workspace / CONFIG_PATH
    if config_path.exists():
        return read_json(config_path)
    config = default_root_config(discovery)
    write_json(config_path, config)
    return config


def repo_doc_paths(repo_name: str) -> dict[str, Path]:
    base = REPO_DOCS_PATH / repo_name
    return {
        "base": base,
        "index": base / "index.md",
        "domains": base / "domains",
        "shared": base / "shared",
    }


def default_entry_paths(repo_scan: dict[str, Any]) -> list[str]:
    detected_kind = repo_scan.get("detected_kind", "unknown")
    manifests = repo_scan.get("manifests", [])
    entry_candidates: list[str] = []

    if detected_kind == "bigfish-console":
        entry_candidates.extend(
            [
                "config/config.ts",
                "config/routes",
                "src/pages",
                "src/services",
            ]
        )
    elif detected_kind == "maven-service":
        entry_candidates.append("pom.xml")
        entry_candidates.extend(repo_scan.get("backend", {}).get("modules", [])[:2])
    elif detected_kind == "node-monorepo":
        # 不存在的候选路径会被下方存在性过滤丢弃。
        entry_candidates.extend(["pnpm-workspace.yaml", "package.json", "packages", "apps"])
    else:
        entry_candidates.extend(manifests[:3])

    for manifest in manifests:
        if manifest not in entry_candidates and len(entry_candidates) < 4:
            entry_candidates.append(manifest)

    # 类型约定路径只有在仓库里真实存在才能进主要入口；
    # 渲染出的裸路径会立刻触发"主要入口不可打开"的卫生警告。
    repo_root = Path(repo_scan["path"]) if repo_scan.get("path") else None
    primary_entry_paths: list[str] = []
    for item in entry_candidates:
        if not item or item in primary_entry_paths:
            continue
        if repo_root is not None and not (repo_root / item).exists():
            continue
        primary_entry_paths.append(item)
    return primary_entry_paths


def default_repo_model(repo_scan: dict[str, Any]) -> dict[str, Any]:
    detected_kind = repo_scan.get("detected_kind", "unknown")
    return {
        "category": detected_kind,
        "audience": "TODO: 补充读者。",
        "summary": "TODO: 补充仓库摘要。",
        "role": "TODO: 补充仓库职责。",
        "primary_entry_paths": default_entry_paths(repo_scan),
        "domains": [],
        "shared_docs": [],
    }


def merge_objects(base: Any, override: Any) -> Any:
    if isinstance(base, dict) and isinstance(override, dict):
        merged = dict(base)
        for key, value in override.items():
            if key in merged:
                merged[key] = merge_objects(merged[key], value)
            else:
                merged[key] = value
        return merged
    return override


def normalize_root_config(config: dict[str, Any]) -> dict[str, Any]:
    config.setdefault("relations", [])
    config.setdefault("standalone_repos", [])
    config.setdefault("suppressed_relations", [])
    return config


def discover_nested_docs(workspace: Path, repo_name: str, folder: str) -> list[dict[str, Any]]:
    paths = repo_doc_paths(repo_name)
    docs_dir = workspace / paths[folder]
    if not docs_dir.exists():
        return []
    docs: list[dict[str, Any]] = []
    for path in sorted(docs_dir.glob("*.md")):
        docs.append(parse_nested_doc(workspace, path.relative_to(workspace)))
    return docs


def parse_existing_repo_index(workspace: Path, repo_name: str) -> dict[str, Any]:
    index_abs = workspace / repo_doc_paths(repo_name)["index"]
    if not index_abs.exists():
        return {}
    content = read_text(index_abs)
    model: dict[str, Any] = {}
    for key, field in [
        ("Category", "category"),
        ("Audience", "audience"),
        ("Summary", "summary"),
        ("Role", "role"),
    ]:
        value = table_value(content, key)
        if value:
            model[field] = value
    entry_value = raw_table_value(content, "Primary Entries")
    if entry_value:
        model["primary_entry_paths"] = parse_entry_paths_from_table(
            workspace, repo_name, index_abs, entry_value
        )

    operation_rows = parse_operation_rows(markdown_section(content.splitlines(), "Common Operations"))
    if operation_rows:
        model["operation_rows"] = operation_rows
    agent_sections = parse_agent_index_sections(content)
    if agent_sections:
        model["agent_sections"] = agent_sections
    return model


def prepare_repo_models(
    workspace: Path,
    config: dict[str, Any],
    discovery: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    scans = repo_map(discovery)
    repo_models: dict[str, dict[str, Any]] = {}
    for repo_name in config.get("workspace", {}).get("repo_order", []):
        model = default_repo_model(scans.get(repo_name, {"name": repo_name}))
        existing_index = parse_existing_repo_index(workspace, repo_name)
        existing_docs = {
            "domains": discover_nested_docs(workspace, repo_name, "domains"),
            "shared_docs": discover_nested_docs(workspace, repo_name, "shared"),
        }
        model = merge_objects(model, existing_index)
        model = merge_objects(model, existing_docs)
        model.setdefault("domains", [])
        model.setdefault("shared_docs", [])
        model.setdefault("operation_rows", [])
        model.setdefault("agent_sections", [])
        repo_models[repo_name] = model
    return repo_models


def bootstrap_config(workspace_name: str) -> dict[str, Any]:
    return {
        "workspace": {
            "name": workspace_name,
            "summary": "TODO: 补充工作区摘要。",
            "positioning": "TODO: 补充工作区定位和边界。",
            "entry_policy": {
                "delete_workspace_md": True,
            },
            "repo_order": [],
            "task_routes": [],
        },
        "relations": [],
        "standalone_repos": [],
        "suppressed_relations": [],
    }


def bootstrap_discovery(workspace: Path) -> dict[str, Any]:
    return {
        "generated_at": None,
        "workspace": {
            "name": workspace.name,
            "path": str(workspace),
            "repo_count": 0,
        },
        "repos": [],
    }


def bootstrap_relation_registry(workspace_name: str) -> dict[str, Any]:
    return {
        "generated_at": None,
        "workspace": workspace_name,
        "repo_order": [],
        "relations": [],
        "standalone_repos": [],
    }
