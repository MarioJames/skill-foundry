#!/usr/bin/env python3
"""非阻断的 validate 卫生检查。所有结果都是警告，不是错误。

阻断式的结构与证据检查在 validate.py。本文件聚焦内容纪律：
字段语义、易漂移值、命名和链接卫生。每条警告都要指出应在哪里修复。
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from core import (
    IGNORED_DIRS,
    REPO_DOCS_PATH,
    extract_markdown_link_pairs,
    extract_markdown_links,
    is_external_link,
    read_text,
    strip_anchor,
)
from mdparse import (
    TABLE_CELL_SPLIT,
    first_paragraph,
    markdown_section,
    parse_operation_rows,
    raw_table_value,
    table_value,
)
from relations import normalize_standalone_repos
from render_root import (
    LEGACY_MEMORY_GUIDANCE,
    MEMORY_DATED_BULLET_RE,
    MEMORY_PLACEHOLDERS,
    MEMORY_SCOPE_HEADING_RE,
    MEMORY_TASK_HEADING_RE,
    memory_candidate_lines,
    strip_memory_placeholder,
)

# 读者必须描述谁阅读或维护这个仓库。暴露/消费/调用 facade/RPC/API 这类措辞
# 属于关系，不属于读者。
AUDIENCE_RELATION_RE = re.compile(
    r"(?:exposes?|consumes?|calls?|invokes?)[^.;|]{0,32}?(?:[Ff]acade|FACADE|RPC|rpc|API|api|client)"
    r"|(?:暴露|消费|调用|依赖)[^。；|]{0,32}?(?:facade|Facade|FACADE|RPC|rpc|API|api|门面|客户端)"
)
# 声明摘要或读者字段里的字面数量会在扫描/评审后漂移。
LITERAL_COUNT_RE = re.compile(
    r"\d+\s*(?:items?|controllers?|packages?|modules?|pages?|files?|people|reviewers?|owners?|entries?)"
    r"|\d+\s*(?:个|项|条|人|名)?\s*(?:控制器|接口|页面|模块|包|评审人|评审者|负责人|文件|条目)",
    re.IGNORECASE,
)
# 行号引用会随目标文件变化而漂移。
LINE_CITATION_RE = re.compile(
    r"\blines?\s+\d+(?:\s*[-~]\s*\d+)?|第?\s*\d+(?:\s*[-~]\s*\d+)?\s*行",
    re.IGNORECASE,
)
# "人工判断"不应包含未完成的仓库内排查。
UNRESOLVED_PROBE_RE = re.compile(
    r"not confirmed in this read|needs? manual follow[- ]?up|not yet read|need to check"
    r"|本次未确认|待人工跟进|尚未阅读|需要核实|需确认",
    re.IGNORECASE,
)

# 链接标签看起来像文件名时，href 必须直接指向该文件。
FILE_LABEL_RE = re.compile(
    r"[\w@./\-]+\.(?:java|kt|ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|sh|md|json|xml|"
    r"yaml|yml|toml|properties|sql|less|css|scss|html|vue)"
)

MEMORY_ENTRY_RE = re.compile(
    r"^-\s+`?\d{4}-\d{2}-\d{2}`?\s+`?\["
    r"(?:偏好|纠正|用户操作|确认决策|接续|preference|correction|user[_ -]?action|"
    r"confirmed[_ -]?decision|handoff)"
    r"\]`?\s+\S",
    re.IGNORECASE,
)
MEMORY_NEGATED_ROUTINE_RE = re.compile(
    r"(?:不要|不再|无需|禁止|避免|停止|勿)"
    r"|(?:do\s+not|don't|never|avoid|stop)\b",
    re.IGNORECASE,
)
MEMORY_ROUTINE_GRAPH_RE = re.compile(
    r"(?:初始化|刷新|重建).{0,24}(?:工作区)?(?:知识图谱|图谱)"
    r"|(?:initialize|initialized|refresh|refreshed|rebuild).{0,24}(?:workspace\s+)?knowledge\s+graph"
    r"|\b(?:bootstrap|scan|init|validate)(?:\s*/\s*(?:bootstrap|scan|init|validate)){2,}\b",
    re.IGNORECASE,
)


def doc_body_first_line(lines: list[str]) -> str:
    """返回第一行非空正文，跳过 YAML frontmatter。"""
    start = 0
    if lines and lines[0].strip() == "---":
        for idx in range(1, len(lines)):
            if lines[idx].strip() == "---":
                start = idx + 1
                break
    for line in lines[start:]:
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def declaration_summary_warnings(config: dict[str, Any]) -> list[str]:
    """声明摘要应保持定性，避免易漂移的数量。"""
    warnings: list[str] = []
    declared_relations = config.get("relations", [])
    if isinstance(declared_relations, list):
        for relation in declared_relations:
            if not isinstance(relation, dict):
                continue
            summary = relation.get("summary", "")
            match = LITERAL_COUNT_RE.search(summary) if isinstance(summary, str) else None
            if match:
                warnings.append(
                    f"关系 {relation.get('from')} -> {relation.get('to')} 的摘要"
                    f"包含字面数量（`{match.group(0)}`）。声明摘要请保持定性；"
                    f"需要精确数量时指向目录或 discovery 快照。"
                )
    for entry in normalize_standalone_repos(config.get("standalone_repos", [])):
        for field in ("summary", "reason"):
            value = entry.get(field, "")
            match = LITERAL_COUNT_RE.search(value) if isinstance(value, str) else None
            if match:
                warnings.append(
                    f"独立仓库 {entry['repo']} 的 {field} 包含字面数量"
                    f"（`{match.group(0)}`）。声明摘要请保持定性；需要精确数量时"
                    f"指向目录或 discovery 快照。"
                )
    return warnings


def memory_placeholder_warnings(workspace: Path) -> list[str]:
    """bootstrap 的 MEMORY 占位与真实条目共存时警告。"""
    memory_path = workspace / "MEMORY.md"
    if not memory_path.exists():
        return []
    memory_content = read_text(memory_path)
    if (
        any(placeholder in memory_content for placeholder in MEMORY_PLACEHOLDERS)
        and strip_memory_placeholder(memory_content) != memory_content
    ):
        return [
            "MEMORY.md 的 bootstrap 占位与有效记忆条目共存。"
            "添加第一条记录时删除占位，或重跑 init 收敛它。"
        ]
    return []


def memory_quality_warnings(workspace: Path, config: dict[str, Any]) -> list[str]:
    """只检查可机械识别的记忆格式和明显流水账；缺失语境由语义评审判断。"""
    memory_path = workspace / "MEMORY.md"
    if not memory_path.exists():
        return []
    content = read_text(memory_path)
    candidate_lines = memory_candidate_lines(content)
    warnings: list[str] = []
    if any(line.strip() in LEGACY_MEMORY_GUIDANCE for line in content.splitlines()):
        warnings.append(
            "MEMORY.md 重复了记忆协议；写入规则应放在 AGENTS.md 的记忆边界，"
            "MEMORY.md 只保留实际条目或空占位。请运行 init 自动迁移。"
        )
    invalid_scopes: list[str] = []
    unscoped_entries: list[str] = []
    malformed_entries: list[str] = []
    empty_field_entries: list[str] = []
    continuation_lines: list[str] = []
    unknown_repos: set[str] = set()
    duplicate_scopes: set[str] = set()
    seen_scopes: set[str] = set()
    seen_tasks: set[str] = set()
    parent_scope: str | None = None
    current_scope: str | None = None
    known_repos = set(config.get("workspace", {}).get("repo_order", []))
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if line.startswith("## "):
            match = MEMORY_SCOPE_HEADING_RE.match(line)
            if not match:
                invalid_scopes.append(line)
                parent_scope = None
                current_scope = None
                continue
            parent_scope = line[3:].strip()
            current_scope = parent_scope
            if parent_scope in seen_scopes:
                duplicate_scopes.add(parent_scope)
            seen_scopes.add(parent_scope)
            repo_name = match.group(1)
            if repo_name and repo_name not in known_repos:
                unknown_repos.add(repo_name)
            continue
        if line.startswith("### "):
            task_match = MEMORY_TASK_HEADING_RE.match(line)
            if not task_match or parent_scope is None:
                invalid_scopes.append(line)
                current_scope = None
                continue
            current_scope = f"{parent_scope}/task:{task_match.group(1)}"
            if current_scope in seen_tasks:
                duplicate_scopes.add(current_scope)
            seen_tasks.add(current_scope)
            continue
        if current_scope is not None and line and not line.startswith("-"):
            continuation_lines.append(line)
            continue
        if not line.startswith("-") or line in MEMORY_PLACEHOLDERS:
            continue
        if current_scope is None:
            if MEMORY_DATED_BULLET_RE.match(line):
                unscoped_entries.append(line)
            else:
                continue
        if not MEMORY_ENTRY_RE.match(line) or not re.search(
            r"(?:来源|source)\s*[:：]", line, re.IGNORECASE
        ) or not re.search(r"(?:结论|conclusion)\s*[:：]", line, re.IGNORECASE):
            malformed_entries.append(line)
            continue
        source_match = re.search(
            r"(?:来源|source)\s*[:：]\s*([^；;\n]*)", line, re.IGNORECASE
        )
        conclusion_match = re.search(
            r"(?:结论|conclusion)\s*[:：]\s*([^；;\n]*)", line, re.IGNORECASE
        )
        source_value = source_match.group(1) if source_match else ""
        conclusion_value = conclusion_match.group(1) if conclusion_match else ""
        strip_noise = lambda value: re.sub(r"[\s。.!！?？]+", "", value)
        if not strip_noise(source_value) or not strip_noise(conclusion_value):
            empty_field_entries.append(line)
    if invalid_scopes or unscoped_entries:
        examples = invalid_scopes[:2] + unscoped_entries[:1]
        compact_examples = [
            item if len(item) <= 120 else item[:117].rstrip() + "..." for item in examples
        ]
        detail = "、".join(f"`{item}`" for item in compact_examples)
        suffix = f"，例如 {detail}" if detail else ""
        warnings.append(
            "MEMORY.md 存在旧式或未分层条目，缺少有效 scope 分节"
            f"{suffix}。请使用 `## workspace` / `## repo:<repo>`，"
            "具体任务嵌套 `### task:<task-key>`。"
        )
    if malformed_entries:
        warnings.append(
            "MEMORY.md 的记录必须是单行 `- <日期> [类型] 来源：…；结论：…`；"
            "类型限偏好、纠正、用户操作、确认决策或接续。"
        )
    if empty_field_entries:
        warnings.append(
            "MEMORY.md 条目的来源和结论必须非空；"
            "请写明可归因来源，以及未来 agent 应采用的当前有效结论。"
        )
    if continuation_lines:
        warnings.append(
            "MEMORY.md 的 scope 内存在跨行正文。每条记忆必须保持单行；"
            "请把补充语境压缩进同一条 `来源：…；结论：…` 记录。"
        )
    if unknown_repos:
        scopes = ", ".join(f"`repo:{name}`" for name in sorted(unknown_repos))
        warnings.append(
            f"MEMORY.md 的 repo scope 指向未知仓库：{scopes}。"
            "请改成 repo_order 中的仓库名，或在跨仓语境下使用 workspace/task scope。"
        )
    if duplicate_scopes:
        duplicated = ", ".join(f"`{scope}`" for scope in sorted(duplicate_scopes))
        warnings.append(
            f"MEMORY.md 存在重复 scope/task 分节：{duplicated}。"
            "请合并同一作用域的记录，避免按需读取遗漏或重复消费。"
        )
    routine_candidates = invalid_scopes + candidate_lines
    has_routine_graph_log = any(
        MEMORY_ROUTINE_GRAPH_RE.search(item) and not MEMORY_NEGATED_ROUTINE_RE.search(item)
        for item in routine_candidates
    )
    if has_routine_graph_log:
        warnings.append(
            "MEMORY.md 疑似记录例行图谱维护或 scan/init/validate 流水账。"
            "若内容可由 git、代码、CI 或 `.workspace/` 恢复，请删除；"
            "只保留无法重建且会影响后续行为的用户语境或接续状态。"
        )
    return warnings


def repo_order_warnings(config: dict[str, Any], discovery: dict[str, Any]) -> list[str]:
    repo_names = [repo["name"] for repo in discovery.get("repos", [])]
    declared_order = config.get("workspace", {}).get("repo_order", [])
    undeclared = [name for name in repo_names if name not in declared_order]
    if undeclared:
        return [f"自动发现的仓库缺失于 repo_order：{', '.join(undeclared)}"]
    return []


def task_route_density_warnings(config: dict[str, Any]) -> list[str]:
    """宽路由应停在 first-hop，避免把某仓全部深层文档预加载进根入口。"""
    warnings: list[str] = []
    routes = config.get("workspace", {}).get("task_routes", [])
    if not isinstance(routes, list):
        return warnings
    for route in routes:
        if not isinstance(route, dict):
            continue
        reads = route.get("read", [])
        if not isinstance(reads, list):
            continue
        deep_reads = [read for read in reads if not str(read).endswith("/index.md")]
        is_overloaded = len(deep_reads) >= 3 or (len(reads) > 3 and len(deep_reads) >= 2)
        if is_overloaded:
            warnings.append(
                f"任务路由 `{route.get('name', '?')}` 预加载了 {len(reads)} 个 read 目标，"
                f"其中 {len(deep_reads)} 个是深层文档。"
                "宽任务应保持 first-hop（通常先读 1-2 个仓库 index），"
                "只有窄主题才直接指向具体 domain/shared；请压缩或确认这些目标都必读。"
            )
    return warnings


def orphan_repo_doc_warnings(
    workspace: Path, config: dict[str, Any], discovery: dict[str, Any]
) -> list[str]:
    warnings: list[str] = []
    repos_docs_dir = workspace / REPO_DOCS_PATH
    if not repos_docs_dir.exists():
        return warnings
    known_repos = set(config.get("workspace", {}).get("repo_order", [])) | {
        repo["name"] for repo in discovery.get("repos", [])
    }
    for child in sorted(repos_docs_dir.iterdir()):
        if child.is_dir() and child.name not in known_repos:
            warnings.append(
                f"孤儿仓库文档：{(REPO_DOCS_PATH / child.name).as_posix()}/ "
                f"不匹配任何扫描到或声明的仓库。若该仓库已删除，请删掉这个文档目录。"
            )
    return warnings


def repo_index_table_warnings(workspace: Path, config: dict[str, Any]) -> list[str]:
    """仓库 index 表格卫生：字段形态和语义漂移检查。"""
    warnings: list[str] = []
    for repo_name in config.get("workspace", {}).get("repo_order", []):
        index_path = workspace / REPO_DOCS_PATH / repo_name / "index.md"
        if not index_path.exists():
            continue
        index_content = read_text(index_path)
        fenced_lines = [
            str(idx + 1)
            for idx, line in enumerate(index_content.splitlines())
            if line.lstrip().startswith("|") and "```" in line
        ]
        if fenced_lines:
            warnings.append(
                f"仓库 `{repo_name}` 的 index.md 表格单元格出现 3 个及以上连续反引号"
                f"（行 {', '.join(fenced_lines)}）。行内代码只用单反引号；"
                f"不要把整个字段值包进反引号外壳。"
            )
        category = raw_table_value(index_content, "Category")
        if (
            category
            and len(category) > 2
            and category.startswith("`")
            and category.endswith("`")
            and "`" in category[1:-1]
        ):
            warnings.append(
                f"仓库 `{repo_name}` 的 index.md 类别字段被反引号包裹却又含行内反引号。"
                f"GFM 会把它拆成损坏的代码跨度。去掉外层外壳，只保留内部行内代码。"
            )
        entry_value = raw_table_value(index_content, "Primary Entries")
        if entry_value:
            repo_root = workspace / repo_name
            # Markdown 链接可达性由链接失效校验覆盖。
            # 这里只审查裸代码跨度形式的入口。
            without_links = re.sub(r"\[[^\]]*\]\([^)]*\)", "", entry_value)
            unopenable: list[str] = []
            for span in re.findall(r"`([^`]+)`", without_links):
                item = span.strip()
                if not item or "*" in item:
                    continue
                if not (repo_root / item).exists():
                    unopenable.append(item)
            if unopenable:
                listed = ", ".join(f"`{item}`" for item in unopenable)
                warnings.append(
                    f"仓库 `{repo_name}` 的 index.md 主要入口包含无法在仓库内打开的条目"
                    f"（{listed}）。主要入口只应列出真实的仓库文件/目录，最好是相对链接。"
                    f"命令放常用操作，散文放摘要或业务域文档。"
                )
        audience = table_value(index_content, "Audience")
        if audience and AUDIENCE_RELATION_RE.search(audience):
            warnings.append(
                f"仓库 `{repo_name}` 的 index.md 读者字段看起来在描述跨仓调用关系。"
                f"读者只应描述读者/维护者群体；暴露/消费 facade 的事实属于 `## 关系` 表和 registry.yaml。"
            )
        if audience:
            count_match = LITERAL_COUNT_RE.search(audience)
            if count_match:
                warnings.append(
                    f"仓库 `{repo_name}` 的 index.md 读者字段包含字面数量"
                    f"（`{count_match.group(0)}`）。团队规模和评审阈值会漂移；"
                    f"指向 OWNERS 类文件而不是内联数字。"
                )
        operation_rows = parse_operation_rows(
            markdown_section(index_content.splitlines(), "Common Operations")
        )
        bare_evidence = [
            row["evidence"]
            for row in operation_rows
            if row["evidence"] != "-" and "](" not in row["evidence"] and "`" not in row["evidence"]
        ]
        if bare_evidence:
            listed = ", ".join(f"`{item}`" for item in bare_evidence[:3])
            warnings.append(
                f"仓库 `{repo_name}` 的 index.md 常用操作有 {len(bare_evidence)} 个证据"
                f"单元格不是链接、行内代码或 `-`（{listed}）。证据应指向可打开的文件。"
                f"若因未转义的 `|` 导致，请修复该行并把单元格内的管道符写成 `\\|`。"
            )
    return warnings


def nested_doc_warnings(workspace: Path, config: dict[str, Any]) -> list[str]:
    """业务域/共享文档卫生：可提取摘要、命名、链接和排查措辞。"""
    warnings: list[str] = []
    for repo_name in config.get("workspace", {}).get("repo_order", []):
        for folder in ("domains", "shared"):
            docs_dir = workspace / REPO_DOCS_PATH / repo_name / folder
            if not docs_dir.exists():
                continue
            missing_summary: list[str] = []
            h1_opening: list[str] = []
            unresolved_probe: list[str] = []
            summary_with_links: list[str] = []
            for doc_path in sorted(docs_dir.glob("*.md")):
                doc_rel = (REPO_DOCS_PATH / repo_name / folder / doc_path.name).as_posix()
                if doc_path.stem == "index":
                    warnings.append(
                        f"{doc_rel} 用 index.md 作为嵌套文档名，容易与目录索引混淆。"
                        f"请改成主题化的 kebab-case slug 并重跑 init。"
                    )
                lines = read_text(doc_path).splitlines()
                if doc_body_first_line(lines).startswith("# "):
                    h1_opening.append(doc_path.name)
                summary = first_paragraph(markdown_section(lines, "Summary"))
                if not summary or summary.startswith("TODO"):
                    missing_summary.append(doc_path.name)
                for target in extract_markdown_links(summary):
                    if target and not is_external_link(target) and not target.startswith("#"):
                        summary_with_links.append(doc_path.name)
                        break
                judgment_lines = markdown_section(lines, "Human Judgment")
                if any(UNRESOLVED_PROBE_RE.search(line) for line in judgment_lines):
                    unresolved_probe.append(doc_path.name)
            if unresolved_probe:
                warnings.append(
                    f"仓库 `{repo_name}` 的 {folder}/ 有 {len(unresolved_probe)} 篇文档的 "
                    f"`人工判断` 小节包含未完成的仓库内排查（{', '.join(unresolved_probe)}）。"
                    f"该小节只用于仓库证据无法回答的问题；未决排查应被核实、改写或删除。"
                )
            if h1_opening:
                warnings.append(
                    f"仓库 `{repo_name}` 的 {folder}/ 有 {len(h1_opening)} 篇文档以 H1 开头"
                    f"（{', '.join(h1_opening)}）。嵌套文档应直接以 `## 摘要` 开头；文件名就是主题。"
                )
            if missing_summary:
                warnings.append(
                    f"仓库 `{repo_name}` 的 {folder}/ 有 {len(missing_summary)} 篇文档缺少可提取的 "
                    f"`## 摘要` 首段，导致仓库 index 文档表摘要渲染为 `-`：{', '.join(missing_summary)}"
                )
            if summary_with_links:
                warnings.append(
                    f"仓库 `{repo_name}` 的 {folder}/ 有 {len(summary_with_links)} 篇文档在 "
                    f"`## 摘要` 里包含相对链接（{', '.join(summary_with_links)}）。摘要是纯文本；"
                    f"把路径证据移到后续小节，避免提取后深度断裂。"
                )
        # 拼错的单数 domain/ 目录会被渲染器忽略。
        singular = workspace / REPO_DOCS_PATH / repo_name / "domain"
        if singular.exists() and any(singular.glob("*.md")):
            warnings.append(
                f"仓库 `{repo_name}` 存在单数 `domain/`；渲染器只读 `domains/`。"
                f"请改名为 `domains/` 并重跑 init，否则这些业务域文档会被忽略。"
            )
    return warnings


def link_label_warnings(workspace: Path, config: dict[str, Any]) -> list[str]:
    """检查链接标签的可读性以及与 href 目标的一致性。"""
    warnings: list[str] = []
    for repo_name in config.get("workspace", {}).get("repo_order", []):
        repo_docs_dir = workspace / REPO_DOCS_PATH / repo_name
        if not repo_docs_dir.exists():
            continue
        path_label_hits: dict[str, int] = {}
        file_label_hits: dict[str, int] = {}
        for doc_path in sorted(repo_docs_dir.rglob("*.md")):
            doc_name = doc_path.relative_to(repo_docs_dir).as_posix()
            for label, raw_target in extract_markdown_link_pairs(read_text(doc_path)):
                target = strip_anchor(raw_target).strip()
                if not target or target.startswith("#") or is_external_link(target):
                    continue
                clean_label = label.strip().strip("`").strip()
                if clean_label.startswith(("./", "../")):
                    path_label_hits[doc_name] = path_label_hits.get(doc_name, 0) + 1
                    continue
                if "*" in clean_label:
                    continue
                if (
                    FILE_LABEL_RE.fullmatch(clean_label)
                    and Path(target.rstrip("/")).name != Path(clean_label).name
                ):
                    file_label_hits[doc_name] = file_label_hits.get(doc_name, 0) + 1
        if path_label_hits:
            warnings.append(
                f"仓库 `{repo_name}` 的文档有 {sum(path_label_hits.values())} 处路径式链接标签"
                f"（{', '.join(sorted(path_label_hits))}）。以 `./` 或 `../` 开头的标签难读且不便复制；"
                f"用文件名或仓库相对标签，让 href 承载路径深度。"
            )
        if file_label_hits:
            warnings.append(
                f"仓库 `{repo_name}` 的文档有 {sum(file_label_hits.values())} 处文件名标签指向了不同路径"
                f"（{', '.join(sorted(file_label_hits))}）。若标签是文件名，href 应直接指向该文件，"
                f"而不是目录或另一个文件。"
            )
    return warnings


def split_table_cells(stripped_line: str) -> list[str]:
    """切分 GFM 表格行：只有未转义的 `|` 才是分隔符。"""
    inner = stripped_line
    if inner.startswith("|"):
        inner = inner[1:]
    inner = re.sub(r"(?<!\\)\|\s*$", "", inner)
    return [cell.strip() for cell in TABLE_CELL_SPLIT.split(inner)]


def malformed_table_rows(content: str) -> list[int]:
    """返回单元格数与表头不一致的数据行（1 基行号）。

    单元格内未转义的管道符会造成多余列；缺列会压塌行。
    代码围栏和没有分隔行的伪表格会被忽略。
    """
    bad: list[int] = []
    in_fence = False
    expected: int | None = None
    pending_header = False
    for line_no, line in enumerate(content.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            expected = None
            pending_header = False
            continue
        if in_fence:
            continue
        if not stripped.startswith("|"):
            expected = None
            pending_header = False
            continue
        cells = split_table_cells(stripped)
        if pending_header:
            pending_header = False
            if cells and all(cell and set(cell) <= {"-", ":", " "} for cell in cells):
                # 分隔行确立表格及其期望列数。
                continue
            # 两行管道符之间没有分隔行，不算 GFM 表格。
            expected = None
        if expected is None:
            expected = len(cells)
            pending_header = True
            continue
        if len(cells) != expected:
            bad.append(line_no)
    return bad


def table_shape_warnings(workspace: Path, config: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    for repo_name in config.get("workspace", {}).get("repo_order", []):
        repo_docs_dir = workspace / REPO_DOCS_PATH / repo_name
        if not repo_docs_dir.exists():
            continue
        bad_rows: list[str] = []
        for doc_path in sorted(repo_docs_dir.rglob("*.md")):
            doc_name = doc_path.relative_to(repo_docs_dir).as_posix()
            bad_rows.extend(
                f"{doc_name}:{line_no}" for line_no in malformed_table_rows(read_text(doc_path))
            )
        if bad_rows:
            warnings.append(
                f"仓库 `{repo_name}` 的文档有 {len(bad_rows)} 行表格单元格数与表头不一致"
                f"（{', '.join(bad_rows)}）。单元格内的管道符必须写成 `\\|`，"
                f"否则重渲染时内容可能被挤进多余单元格或丢失。"
            )
    return warnings


# 值得全工作区 grep 的高信号标识符：6 个及以上字符，且含大写或下划线。
IDENTIFIER_PART_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]{5,}")
# 关系类型/方向是图谱词汇，不是代码标识符。
GRAPH_VOCABULARY = {"consumes_api", "depends_on_repo_artifacts", "peer", "directed"}
# 语料只纳入类文本的源码/配置文件。生成目录和超大文件跳过。
SOURCE_CORPUS_SUFFIXES = {
    "java", "kt", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "rb",
    "sh", "md", "json", "xml", "yaml", "yml", "toml", "properties", "sql", "less",
    "css", "scss", "html", "vue", "acl", "conf", "txt", "gradle", "cfg", "ini",
}
MAX_CORPUS_FILE_BYTES = 1_000_000


def extract_identifier_candidates(
    text: str, extra_vocabulary: set[str] | None = None
) -> set[str]:
    """从反引号代码跨度中提取高信号代码标识符候选。

    命令、路径、glob/占位形态和图谱词汇会被忽略。`extra_vocabulary` 由调用方传入
    额外的图谱词汇（如工作区实际声明的关系类型），一并从候选中排除。
    注解前缀和点号链在检查令牌形态前先拆分。
    """
    vocabulary = GRAPH_VOCABULARY | (extra_vocabulary or set())
    candidates: set[str] = set()
    for span in re.findall(r"`([^`]+)`", text):
        span = span.strip()
        if not span or any(ch in span for ch in " \t<>*(){}$#\\'\","):
            continue
        if "/" in span or "-" in span:
            continue
        for part in span.lstrip("@").split("."):
            if not IDENTIFIER_PART_RE.fullmatch(part):
                continue
            if "_" not in part and part.islower():
                continue
            if part in vocabulary:
                continue
            if "Xxx" in part:
                continue
            candidates.add(part)
    return candidates


def declared_relation_vocabulary(config: dict[str, Any]) -> set[str]:
    """工作区实际声明的关系类型（含被抑制的类型）。

    关系类型是用户在 metadata 里声明的开放字符串（如 `consumes_rpc`），会渲染进
    仓库 index 的关系表。从声明派生词汇，避免静态白名单漏项造成的误报漂移。
    """
    vocabulary: set[str] = set()
    relations = config.get("relations", [])
    if isinstance(relations, list):
        for relation in relations:
            if isinstance(relation, dict):
                relation_type = relation.get("type")
                if isinstance(relation_type, str) and relation_type:
                    vocabulary.add(relation_type)
    for relation_type in config.get("suppressed_relation_types", []):
        if isinstance(relation_type, str) and relation_type:
            vocabulary.add(relation_type)
    return vocabulary


def find_missing_identifiers(
    workspace: Path, repo_names: list[str], tokens: set[str]
) -> set[str]:
    """流式扫描仓库源码/配置内容和文件名，返回工作区零命中的标识符。

    逐文件匹配并在找齐后提前退出，避免把整个工作区源码拼进内存。
    """
    missing = set(tokens)
    for repo_name in repo_names:
        repo_root = workspace / repo_name
        if not repo_root.is_dir():
            continue
        for base, dirs, files in os.walk(repo_root):
            if not missing:
                return missing
            dirs[:] = [d for d in dirs if d not in IGNORED_DIRS and not d.startswith(".")]
            for file_name in files:
                suffix = Path(file_name).suffix.lstrip(".").lower()
                if suffix and suffix not in SOURCE_CORPUS_SUFFIXES:
                    continue
                path = Path(base) / file_name
                try:
                    if path.stat().st_size > MAX_CORPUS_FILE_BYTES:
                        continue
                    text = path.read_text(encoding="utf-8", errors="ignore")
                except OSError:
                    continue
                haystack = f"{file_name}\n{text}"
                missing = {token for token in missing if token not in haystack}
                if not missing:
                    return missing
    return missing


def identifier_existence_warnings(workspace: Path, config: dict[str, Any]) -> list[str]:
    """文档中的高信号标识符在工作区源码里找不到时警告。"""
    repo_order = config.get("workspace", {}).get("repo_order", [])
    extra_vocabulary = declared_relation_vocabulary(config)
    candidates_by_repo: dict[str, dict[str, list[str]]] = {}
    for repo_name in repo_order:
        repo_docs_dir = workspace / REPO_DOCS_PATH / repo_name
        if not repo_docs_dir.exists():
            continue
        for doc_path in sorted(repo_docs_dir.rglob("*.md")):
            doc_name = doc_path.relative_to(repo_docs_dir).as_posix()
            for token in sorted(extract_identifier_candidates(read_text(doc_path), extra_vocabulary)):
                candidates_by_repo.setdefault(repo_name, {}).setdefault(token, []).append(doc_name)
    if not candidates_by_repo:
        return []
    all_tokens = {token for tokens in candidates_by_repo.values() for token in tokens}
    missing_tokens = find_missing_identifiers(workspace, repo_order, all_tokens)
    warnings: list[str] = []
    for repo_name in repo_order:
        missing = [
            (token, docs)
            for token, docs in sorted(candidates_by_repo.get(repo_name, {}).items())
            if token in missing_tokens
        ]
        if missing:
            listed = "; ".join(
                f"`{token}`（{', '.join(sorted(set(docs)))}）" for token, docs in missing
            )
            warnings.append(
                f"仓库 `{repo_name}` 的文档引用了工作区 grep 找不到的代码标识符：{listed}。"
                f"这些常是转写错误。编辑文档前先核对代码；确实存在于代码里的奇怪拼写是事实，"
                f"不要随意更正。"
            )
    return warnings


def line_citation_warnings(workspace: Path, config: dict[str, Any]) -> list[str]:
    """行号引用会漂移；优先用 bean ID 或方法名等稳定锚点。"""
    warnings: list[str] = []
    for repo_name in config.get("workspace", {}).get("repo_order", []):
        repo_docs_dir = workspace / REPO_DOCS_PATH / repo_name
        if not repo_docs_dir.exists():
            continue
        hits: list[str] = []
        for doc_path in sorted(repo_docs_dir.rglob("*.md")):
            doc_name = doc_path.relative_to(repo_docs_dir).as_posix()
            count = len(LINE_CITATION_RE.findall(read_text(doc_path)))
            if count:
                hits.append(f"{doc_name}（{count}）")
        if hits:
            warnings.append(
                f"仓库 `{repo_name}` 的文档包含行号引用（{', '.join(hits)}）。"
                f"行号引用会随文件编辑漂移；改用 bean ID、方法名或小节名等稳定锚点。"
            )
    return warnings


def subarea_coverage_tokens(name: str) -> set[str]:
    """业务子区名的覆盖匹配候选。

    命中判定用子串匹配，偏向"已覆盖"以压低误报：一个子区只要其原名、末段路径，
    或 CamelCase→SNAKE_UPPER 形式（页面目录 CarInsurance ↔ 路由常量 CAR_INSURANCE）
    中任意一个出现在文档里，就算被覆盖。
    """
    tokens = {name}
    tail = name.rsplit("/", 1)[-1]
    if tail:
        tokens.add(tail)
        tokens.add(re.sub(r"(?<!^)(?=[A-Z])", "_", tail).upper())
    return {token for token in tokens if token}


def domain_subarea_coverage_warnings(
    workspace: Path, config: dict[str, Any], discovery: dict[str, Any]
) -> list[str]:
    """仓库已有业务域文档，却漏掉扫描到的业务子区时警告。

    只审前端页面分组与 monorepo 包/应用这类业务子区。后端 Maven 模块是架构分层
    （app/web、app/common/dal 等），不是业务域单位，会造成纯误报，故排除。零业务域
    文档的情况由 validate.py 的 DOMAIN_COVERAGE_THRESHOLD 阻断检查兜底——该阈值仍把
    模块计入复杂度代理，与本检查口径不同是有意的；这里只把"有域文档但整块子区静默
    缺失"从未知盲区变成可见的、可被有意识推迟或补上的缺口。
    """
    warnings: list[str] = []
    scan_by_repo = {repo.get("name"): repo for repo in discovery.get("repos", [])}
    for repo_name in config.get("workspace", {}).get("repo_order", []):
        scan = scan_by_repo.get(repo_name, {})
        # "apps" 只存在于遗留快照；新扫描把应用并入 packages。
        subareas = (
            list(scan.get("frontend", {}).get("page_groups", []))
            + list(scan.get("monorepo", {}).get("packages", []))
            + list(scan.get("monorepo", {}).get("apps", []))
        )
        if not subareas:
            continue
        domains_dir = workspace / REPO_DOCS_PATH / repo_name / "domains"
        domain_docs = sorted(domains_dir.glob("*.md")) if domains_dir.exists() else []
        if not domain_docs:
            continue
        corpus_parts = [read_text(path) for path in domain_docs]
        shared_dir = workspace / REPO_DOCS_PATH / repo_name / "shared"
        if shared_dir.exists():
            corpus_parts.extend(read_text(path) for path in sorted(shared_dir.glob("*.md")))
        corpus = "\n".join(corpus_parts)
        uncovered = [
            subarea
            for subarea in subareas
            if not any(token in corpus for token in subarea_coverage_tokens(subarea))
        ]
        if uncovered:
            listed = ", ".join(uncovered)
            warnings.append(
                f"仓库 `{repo_name}` 有 {len(uncovered)} 个业务子区未被任何业务域/共享文档提及"
                f"（{listed}）。这些页面分组/包很可能是研究阶段漏掉的业务域；"
                f"确认后补进 .workspace/repos/{repo_name}/domains/，"
                f"或在既有文档里说明其状态（如未挂载、已废弃）。"
            )
    return warnings


def collect_hygiene_warnings(
    workspace: Path, config: dict[str, Any], discovery: dict[str, Any]
) -> list[str]:
    warnings: list[str] = []
    warnings.extend(repo_order_warnings(config, discovery))
    warnings.extend(task_route_density_warnings(config))
    warnings.extend(orphan_repo_doc_warnings(workspace, config, discovery))
    warnings.extend(domain_subarea_coverage_warnings(workspace, config, discovery))
    warnings.extend(declaration_summary_warnings(config))
    warnings.extend(memory_placeholder_warnings(workspace))
    warnings.extend(memory_quality_warnings(workspace, config))
    warnings.extend(nested_doc_warnings(workspace, config))
    warnings.extend(repo_index_table_warnings(workspace, config))
    warnings.extend(table_shape_warnings(workspace, config))
    warnings.extend(link_label_warnings(workspace, config))
    warnings.extend(line_citation_warnings(workspace, config))
    warnings.extend(identifier_existence_warnings(workspace, config))
    return warnings
