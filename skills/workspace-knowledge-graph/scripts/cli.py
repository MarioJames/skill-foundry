#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from config import (
    LEGACY_CONFIG_KEYS,
    load_or_create_root_config,
    normalize_root_config,
    prepare_repo_models,
)
from core import CONFIG_PATH, DISCOVERY_PATH, write_json
from discovery import discover_workspace
from relations import relation_shape_errors
from render import render_workspace
from render_root import bootstrap_workspace
from validate import validate_workspace


def cmd_validate(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    errors, warnings = validate_workspace(workspace)
    if not errors and not warnings:
        print("工作区图谱校验通过。")
        return 0
    if warnings:
        print("警告：")
        for item in warnings:
            print(f"- {item}")
    if errors:
        print("错误：")
        for item in errors:
            print(f"- {item}")
        return 1
    return 0


def cmd_bootstrap(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    bootstrap_workspace(workspace)
    return 0


def ensure_repo_order(config: dict[str, Any], discovery: dict[str, Any]) -> dict[str, Any]:
    detected_order = [repo["name"] for repo in discovery["repos"]]
    declared_order = config.get("workspace", {}).get("repo_order", [])
    final_order = [name for name in declared_order if name in detected_order]
    for name in detected_order:
        if name not in final_order:
            final_order.append(name)
    config.setdefault("workspace", {})["repo_order"] = final_order
    return config


def cmd_scan(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    discovery = discover_workspace(workspace)
    # 研究阶段的前置条件：在 init 之前持久化快照，供各 agent 直接读取。
    write_json(workspace / DISCOVERY_PATH, discovery)
    # stdout 只给紧凑摘要；全量 JSON 会灌爆 agent 上下文，细节读持久化快照。
    print(f"已写入扫描快照：{DISCOVERY_PATH.as_posix()}（{len(discovery['repos'])} 个仓库）")
    for repo in discovery["repos"]:
        print(f"- {repo['name']}: {repo['detected_kind']}, {repo['package_manager']}")
    return 0


def json_syntax_error(exc: json.JSONDecodeError) -> str:
    return (
        f"{CONFIG_PATH.as_posix()} 必须使用 JSON 语法（`.yaml` 只是历史遗留的扩展名约定；"
        f"见 references/config-schema.md）：{exc}"
    )


def cmd_init(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    bootstrap_workspace(workspace)
    discovery = discover_workspace(workspace)
    try:
        config = load_or_create_root_config(workspace, discovery)
    except json.JSONDecodeError as exc:
        print(json_syntax_error(exc))
        return 1
    legacy_keys = [key for key in LEGACY_CONFIG_KEYS if key in config]
    if legacy_keys:
        # 自动迁移已移除。带着遗留键渲染会悄悄丢弃声明，
        # 所以 init 必须拒绝执行并指向手动迁移。
        print(
            f"{CONFIG_PATH.as_posix()} 包含遗留声明键 {', '.join(f'`{key}`' for key in legacy_keys)}：\n"
            "- 请手动把有用的 `repos` 声明沉淀到 .workspace/repos/<repo>/ 的 Markdown 事实源。\n"
            "- 请手动把有价值的 `memory_seed` 条目搬进 MEMORY.md。\n"
            "- 删除这些遗留键后重跑 init。"
        )
        return 1
    shape_errors = relation_shape_errors(config.get("relations", []))
    if shape_errors:
        # 带着缺字段的声明渲染会在合并途中 KeyError；init 必须先给指位报错。
        print(f"{CONFIG_PATH.as_posix()} 的关系声明缺少必需字段，init 拒绝执行：")
        for item in shape_errors:
            print(f"- {item}")
        return 1
    config = normalize_root_config(config)
    config = ensure_repo_order(config, discovery)
    repo_models = prepare_repo_models(workspace, config, discovery)
    write_json(workspace / CONFIG_PATH, config)
    render_workspace(workspace, config, repo_models, discovery)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="初始化或刷新工作区文档。")
    subparsers = parser.add_subparsers(dest="command", required=True)

    bootstrap = subparsers.add_parser("bootstrap", help="创建工作区根骨架和占位文件，只补缺失文件。")
    bootstrap.add_argument("--workspace", required=True)
    bootstrap.set_defaults(func=cmd_bootstrap)

    scan = subparsers.add_parser("scan", help="扫描工作区并输出 discovery JSON。")
    scan.add_argument("--workspace", required=True)
    scan.set_defaults(func=cmd_scan)

    init = subparsers.add_parser("init", help="缺配置时创建配置，并渲染工作区文档。")
    init.add_argument("--workspace", required=True)
    init.set_defaults(func=cmd_init)

    validate = subparsers.add_parser("validate", help="校验生成的工作区文档和本地链接。")
    validate.add_argument("--workspace", required=True)
    validate.set_defaults(func=cmd_validate)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)
