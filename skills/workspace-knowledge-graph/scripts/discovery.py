#!/usr/bin/env python3

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from core import IGNORED_DIRS, read_json, read_text, shell, utc_now


def list_git_repos(workspace: Path) -> list[Path]:
    repos: list[Path] = []
    for child in sorted(workspace.iterdir(), key=lambda item: item.name):
        if child.is_dir() and (child / ".git").exists():
            repos.append(child)
    return repos


def count_source_files(root: Path, patterns: dict[str, str]) -> dict[str, int]:
    """单次遍历统计多种源码文件数，避免每个后缀各扫一遍仓库。"""
    counts = dict.fromkeys(patterns, 0)
    for current_root, dirnames, filenames in os.walk(root):
        dirnames[:] = [item for item in dirnames if item not in IGNORED_DIRS]
        for filename in filenames:
            for key, pattern in patterns.items():
                if Path(filename).match(pattern):
                    counts[key] += 1
    return counts


def read_first_heading(path: Path) -> str | None:
    if not path.exists():
        return None
    for line in read_text(path).splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip()
    return None


def parse_package_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return read_json(path)


def parse_pom_modules(path: Path) -> list[str]:
    if not path.exists():
        return []
    return re.findall(r"<module>([^<]+)</module>", read_text(path))


def list_page_groups(repo_root: Path) -> list[str]:
    pages_dir = repo_root / "src/pages"
    if not pages_dir.exists():
        return []
    groups = [path.name for path in sorted(pages_dir.iterdir()) if path.is_dir()]
    return groups


def list_route_files(repo_root: Path) -> list[str]:
    routes_dir = repo_root / "config/routes"
    if not routes_dir.exists():
        return []
    files = []
    for path in sorted(routes_dir.glob("*.ts")):
        if path.name != "index.ts":
            files.append(str(path.relative_to(repo_root)).replace(os.sep, "/"))
    return files


def list_service_targets(repo_root: Path) -> list[str]:
    services_dir = repo_root / "src/services"
    if not services_dir.exists():
        return []
    targets = [path.name for path in sorted(services_dir.iterdir()) if path.is_dir()]
    return targets


def parse_pnpm_workspace_globs(path: Path) -> list[str]:
    """从 pnpm-workspace.yaml 的 packages 块提取 glob（零依赖的窄解析）。"""
    if not path.exists():
        return []
    globs: list[str] = []
    in_packages = False
    for raw_line in read_text(path).splitlines():
        line = raw_line.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        stripped = line.strip()
        if not line.startswith((" ", "\t")) and not stripped.startswith("- "):
            in_packages = stripped == "packages:"
            continue
        if in_packages and stripped.startswith("- "):
            value = stripped[2:].strip().strip("'\"")
            if value and not value.startswith("!"):
                globs.append(value)
    return globs


def package_workspace_globs(package_json: dict[str, Any]) -> list[str]:
    """package.json 的 workspaces 字段（yarn / npm workspace，数组或 {packages} 形式）。"""
    workspaces = package_json.get("workspaces")
    if isinstance(workspaces, dict):
        workspaces = workspaces.get("packages")
    if not isinstance(workspaces, list):
        return []
    return [item for item in workspaces if isinstance(item, str) and item and not item.startswith("!")]


def list_workspace_packages(repo_root: Path, package_json: dict[str, Any]) -> list[str]:
    """按声明的 workspace glob 收集包名；无声明时退化为 packages/、apps/ 目录约定。"""
    globs = parse_pnpm_workspace_globs(repo_root / "pnpm-workspace.yaml")
    globs += [item for item in package_workspace_globs(package_json) if item not in globs]
    if not globs:
        globs = ["packages/*", "apps/*"]
    names: list[str] = []
    for pattern in globs:
        if pattern.startswith(("/", "..")):
            continue
        for manifest in sorted(repo_root.glob(f"{pattern.rstrip('/')}/package.json")):
            if "node_modules" in manifest.parts:
                continue
            name = parse_package_json(manifest).get("name")
            if name and name not in names:
                names.append(name)
    return names


def detect_repo_kind(repo_root: Path, package_json: dict[str, Any]) -> str:
    if (repo_root / "pom.xml").exists():
        return "maven-service"
    if (repo_root / "config/config.ts").exists():
        return "bigfish-console"
    if (repo_root / "pnpm-workspace.yaml").exists() or package_workspace_globs(package_json):
        return "node-monorepo"
    # shell 交付类仓库不单设类型：形状因仓库而异，容易过拟合。
    # 该信号由 package_manager=shell-scripts 和 build.sh/release.sh 操作行呈现。
    if (repo_root / "package.json").exists():
        return "node-repo"
    return "unknown"


def shell_scripts_are_primary(package_json: dict[str, Any], repo_root: Path) -> bool:
    if not package_json:
        return False
    shell_entrypoints = [repo_root / "build.sh", repo_root / "release.sh"]
    if not any(path.exists() for path in shell_entrypoints):
        return False
    scripts = package_json.get("scripts", {})
    if not isinstance(scripts, dict):
        return True
    npm_workflow_scripts = {"dev", "start", "build", "test", "lint"}
    return not any(name in scripts for name in npm_workflow_scripts)


def detect_package_manager(package_json: dict[str, Any], repo_root: Path, detected_kind: str) -> str:
    if detected_kind == "maven-service":
        return "maven"
    package_manager = package_json.get("packageManager")
    if isinstance(package_manager, str) and package_manager:
        return package_manager
    if (repo_root / "pnpm-workspace.yaml").exists():
        return "pnpm"
    if not package_json:
        return "N/A"
    if shell_scripts_are_primary(package_json, repo_root):
        return "shell-scripts"
    # 锁文件是明确的包管理器信号；tnpm 只作为没有任何信号时的组织默认。
    for lockfile, manager in (
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
        ("package-lock.json", "npm"),
    ):
        if (repo_root / lockfile).exists():
            return manager
    return "tnpm"


def collect_manifest_paths(repo_root: Path) -> list[str]:
    candidates = [
        repo_root / "package.json",
        repo_root / "pom.xml",
        repo_root / "pnpm-workspace.yaml",
        repo_root / "build.gradle",
        repo_root / "build.gradle.kts",
        repo_root / "go.mod",
        repo_root / "Cargo.toml",
        repo_root / "pyproject.toml",
        repo_root / "README.md",
        repo_root / "config/config.ts",
    ]
    paths = [str(path.relative_to(repo_root)).replace(os.sep, "/") for path in candidates if path.exists()]
    return paths


def find_repo_files(repo_root: Path, filename: str) -> list[Path]:
    """按 IGNORED_DIRS 剪枝查找命名文件，避免扫进 node_modules / target 等目录。"""
    found: list[Path] = []
    for base, dirnames, filenames in os.walk(repo_root):
        dirnames[:] = sorted(item for item in dirnames if item not in IGNORED_DIRS)
        if filename in filenames:
            found.append(Path(base) / filename)
    return found


def sibling_mentions(repo_root: Path, sibling_names: list[str]) -> dict[str, dict[str, Any]]:
    files = find_repo_files(repo_root, "pom.xml")
    if (repo_root / "config/config.ts").exists():
        files.append(repo_root / "config/config.ts")
    mentions: dict[str, dict[str, Any]] = {}
    for sibling in sibling_names:
        total = 0
        matched: list[str] = []
        pattern = re.compile(rf"\b{re.escape(sibling)}\b")
        for path in files:
            try:
                count = len(pattern.findall(read_text(path)))
            except UnicodeDecodeError:
                continue
            if count:
                total += count
                matched.append(str(path.relative_to(repo_root)).replace(os.sep, "/"))
        if total:
            # 把真正命中的文件留作关系证据。
            mentions[sibling] = {"count": total, "files": sorted(matched)}
    return mentions


def build_repo_scan(repo_root: Path, sibling_names: list[str]) -> dict[str, Any]:
    package_json = parse_package_json(repo_root / "package.json")
    readme_title = read_first_heading(repo_root / "README.md")
    detected_kind = detect_repo_kind(repo_root, package_json)
    repo_scan: dict[str, Any] = {
        "name": repo_root.name,
        "path": str(repo_root),
        "remote": shell("git", "remote", "get-url", "origin", cwd=repo_root),
        "detected_kind": detected_kind,
        "package_manager": detect_package_manager(package_json, repo_root, detected_kind),
        "manifests": collect_manifest_paths(repo_root),
        "readme_title": readme_title,
        "counts": count_source_files(
            repo_root,
            {
                "java_files": "*.java",
                "kt_files": "*.kt",
                "ts_files": "*.ts",
                "tsx_files": "*.tsx",
                "py_files": "*.py",
                "go_files": "*.go",
                "rs_files": "*.rs",
            },
        ),
        "package": {
            "name": package_json.get("name"),
            "scripts": sorted(package_json.get("scripts", {}).keys()),
            "script_commands": package_json.get("scripts", {})
            if isinstance(package_json.get("scripts"), dict)
            else {},
        },
        "frontend": {
            "page_groups": list_page_groups(repo_root),
            "route_files": list_route_files(repo_root),
            "service_targets": list_service_targets(repo_root),
        },
        "backend": {
            "modules": parse_pom_modules(repo_root / "pom.xml"),
        },
        # 遗留快照可能还带 "apps" 键；读取方保持 .get 容忍即可。
        "monorepo": {
            "packages": list_workspace_packages(repo_root, package_json),
        },
        "sibling_mentions": sibling_mentions(repo_root, sibling_names),
    }
    return repo_scan


def repo_map(discovery: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {repo["name"]: repo for repo in discovery["repos"]}


def discover_workspace(workspace: Path) -> dict[str, Any]:
    repos = list_git_repos(workspace)
    sibling_names = [repo.name for repo in repos]
    scanned = [build_repo_scan(repo, [name for name in sibling_names if name != repo.name]) for repo in repos]
    return {
        "generated_at": utc_now(),
        "workspace": {
            "name": workspace.name,
            "path": str(workspace),
            "repo_count": len(repos),
        },
        "repos": scanned,
    }
