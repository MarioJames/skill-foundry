#!/usr/bin/env python3
"""渲染编排：合并关系、调用根/仓库渲染器并写出产物。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from core import (
    DISCOVERY_PATH,
    RELATION_INDEX_PATH,
    RELATION_REGISTRY_PATH,
    WORKSPACE_INDEX_PATH,
    read_text,
    write_json,
    write_text,
)
from relations import auto_relations, merge_relations, suppress_relations
from render_repo import render_all_repo_docs
from render_root import (
    normalize_memory_document,
    render_agents,
    render_bootstrap_memory,
    render_claude,
    render_relation_index,
    render_relation_registry,
    render_workspace_index,
    strip_memory_placeholder,
)


def render_workspace(
    workspace: Path,
    config: dict[str, Any],
    repo_models: dict[str, dict[str, Any]],
    discovery: dict[str, Any],
) -> None:
    relations = merge_relations(config.get("relations", []), auto_relations(discovery))
    relations = suppress_relations(
        relations,
        config.get("suppressed_relations", []),
        config.get("suppressed_relation_types", []),
    )
    write_json(workspace / DISCOVERY_PATH, discovery)
    write_json(
        workspace / RELATION_REGISTRY_PATH,
        render_relation_registry(config, discovery, relations),
    )
    write_text(
        workspace / RELATION_INDEX_PATH,
        render_relation_index(relations, config.get("standalone_repos", []), config),
    )
    write_text(
        workspace / WORKSPACE_INDEX_PATH,
        render_workspace_index(workspace, config, repo_models, discovery),
    )
    write_text(workspace / Path("AGENTS.md"), render_agents(workspace, config, discovery))
    write_text(workspace / Path("CLAUDE.md"), render_claude())
    memory_path = workspace / Path("MEMORY.md")
    if not memory_path.exists():
        write_text(memory_path, render_bootstrap_memory())
    else:
        existing_memory = read_text(memory_path)
        normalized_memory = normalize_memory_document(existing_memory)
        cleaned_memory = strip_memory_placeholder(normalized_memory)
        if cleaned_memory != existing_memory:
            write_text(memory_path, cleaned_memory)
    render_all_repo_docs(workspace, config, repo_models, discovery, relations)

    delete_workspace_md = (
        config.get("workspace", {})
        .get("entry_policy", {})
        .get("delete_workspace_md", False)
    )
    if delete_workspace_md:
        legacy = workspace / "WORKSPACE.md"
        if legacy.exists():
            legacy.unlink()
