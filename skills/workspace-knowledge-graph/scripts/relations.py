#!/usr/bin/env python3

from __future__ import annotations

from typing import Any


def relation_shape_errors(relations: Any) -> list[str]:
    """声明关系的最小 schema 检查。

    metadata.yaml 是手写 JSON；缺 from/to/type 应得到指位报错，
    而不是渲染或合并途中的 KeyError 堆栈。
    """
    if not isinstance(relations, list):
        return ["`relations` 必须是数组。"]
    errors: list[str] = []
    for index, relation in enumerate(relations):
        if not isinstance(relation, dict):
            errors.append(f"relations[{index}] 必须是对象。")
            continue
        for key in ("from", "to", "type"):
            value = relation.get(key)
            if not isinstance(value, str) or not value:
                errors.append(f"relations[{index}] 缺少非空字符串字段 `{key}`。")
    return errors


def normalize_standalone_repos(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        return []
    normalized: list[dict[str, Any]] = []
    for item in items:
        if isinstance(item, str) and item:
            normalized.append(
                {
                    "repo": item,
                    "summary": "",
                    "reason": "",
                    "evidence": [],
                }
            )
            continue
        if not isinstance(item, dict) or not item.get("repo"):
            continue
        normalized.append(
            {
                "repo": item["repo"],
                "summary": item.get("summary", ""),
                "reason": item.get("reason", ""),
                "evidence": item.get("evidence", []),
            }
        )
    return normalized


def merge_evidence(*groups: list[str]) -> list[str]:
    """合并证据路径，并按去掉尾部斜杠后的拼写去重。

    声明关系和检测关系常把同一路径写成带斜杠和不带斜杠两种拼写。
    保留最先出现的拼写，排序以保证输出稳定。
    """
    kept: dict[str, str] = {}
    for group in groups:
        for item in group or []:
            key = item.rstrip("/") or item
            kept.setdefault(key, item)
    return sorted(kept.values())


def mention_details(mention: Any) -> tuple[int, list[str]]:
    """同时兼容新版 {count, files} 快照和只有计数的旧版快照。"""
    if isinstance(mention, dict):
        return mention.get("count", 0), mention.get("files", [])
    return mention, ["pom.xml"]


def auto_relations(discovery: dict[str, Any]) -> list[dict[str, Any]]:
    repo_names = {repo["name"] for repo in discovery["repos"]}
    relations: list[dict[str, Any]] = []
    for repo in discovery["repos"]:
        source = repo["name"]
        manifests = set(repo.get("manifests", []))
        for target in repo.get("frontend", {}).get("service_targets", []):
            if target in repo_names:
                # 证据必须是真实路径。service 目录是探测来源；
                # config/config.ts 只在实际存在时纳入。
                evidence = []
                if "config/config.ts" in manifests:
                    evidence.append(f"{source}/config/config.ts")
                evidence.append(f"{source}/src/services/{target}")
                relations.append(
                    {
                        "from": source,
                        "to": target,
                        "type": "consumes_api",
                        "direction": "directed",
                        "summary": f"{source} 通过生成的 service client 直接消费 {target}。",
                        "evidence": evidence,
                        "source": "detected",
                    }
                )
        for target, mention in sorted(repo.get("sibling_mentions", {}).items()):
            if target in repo_names and repo["detected_kind"] == "maven-service":
                count, files = mention_details(mention)
                relations.append(
                    {
                        "from": source,
                        "to": target,
                        "type": "depends_on_repo_artifacts",
                        "direction": "directed",
                        "summary": f"{target} 出现在 {source} 的 Maven 配置或入口声明中，构成仓库级依赖证据。",
                        "evidence": [f"{source}/{item}" for item in files]
                        + [f"mention_count={count}"],
                        "source": "detected",
                    }
                )
    deduped: dict[tuple[str, str, str], dict[str, Any]] = {}
    for relation in relations:
        key = (relation["from"], relation["to"], relation["type"])
        if key not in deduped:
            deduped[key] = relation
            continue
        existing = deduped[key]
        existing["evidence"] = merge_evidence(
            existing.get("evidence", []), relation.get("evidence", [])
        )
    return list(deduped.values())


def merge_relations(
    declared: list[dict[str, Any]],
    detected: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    merged: dict[tuple[str, str, str], dict[str, Any]] = {}
    for relation in declared + detected:
        key = (relation["from"], relation["to"], relation["type"])
        if key not in merged:
            merged[key] = dict(relation)
            continue
        current = merged[key]
        current["direction"] = current.get("direction") or relation.get("direction", "directed")
        current["summary"] = current.get("summary") or relation.get("summary", "")
        current["evidence"] = merge_evidence(
            current.get("evidence", []), relation.get("evidence", [])
        )
        sources = {current.get("source", "declared"), relation.get("source", "detected")}
        current["source"] = "+".join(sorted(sources))
    for relation in merged.values():
        relation.setdefault("direction", "directed")
        relation.setdefault("source", "declared")
        relation.setdefault("evidence", [])
    # depends_on_repo_artifacts 是"配置里提到了对方仓库"的弱证据。
    # 声明边已确认语义关系时，保留纯检测的提及边只会让可读图谱重复。
    # peer 声明在该折叠规则下覆盖两个方向。
    declared_pairs: set[tuple[str, str]] = set()
    for item in merged.values():
        if "declared" not in item.get("source", ""):
            continue
        declared_pairs.add((item["from"], item["to"]))
        if item.get("direction") == "peer":
            declared_pairs.add((item["to"], item["from"]))
    folded = [
        relation
        for relation in merged.values()
        if not (
            relation["type"] == "depends_on_repo_artifacts"
            and relation.get("source") == "detected"
            and (relation["from"], relation["to"]) in declared_pairs
        )
    ]
    return sorted(folded, key=lambda item: (item["from"], item["to"], item["type"]))


def suppress_relations(
    relations: list[dict[str, Any]],
    suppressed: list[dict[str, Any]],
    suppressed_types: list[str] | None = None,
) -> list[dict[str, Any]]:
    keys = {
        (item["from"], item["to"], item["type"])
        for item in suppressed
        if {"from", "to", "type"} <= set(item.keys())
    }
    types = {item for item in (suppressed_types or [])}
    if not keys and not types:
        return relations
    return [
        relation
        for relation in relations
        if (relation["from"], relation["to"], relation["type"]) not in keys
        and relation.get("type") not in types
    ]
