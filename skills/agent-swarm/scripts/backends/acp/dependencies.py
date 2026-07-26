"""Offline activation of the official SDK bundled with the installed skill."""

import hashlib
import json
import os
import pathlib
import platform
import shutil
import sys
import tempfile
import zipfile

try:
    import fcntl
except ImportError:  # Windows is outside the v1 Unix-socket support boundary.
    fcntl = None


SKILL_DIR = pathlib.Path(__file__).resolve().parents[3]
BUNDLE_DIR = SKILL_DIR / "assets" / "acp-runtime"
MANIFEST_PATH = BUNDLE_DIR / "manifest.json"
CACHE_ENV = "AGENT_SWARM_ACP_BUNDLE_CACHE"
SUPPORTED_MINORS = {10, 11, 12, 13, 14}


def _digest(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_manifest():
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RuntimeError(
            "bundled ACP runtime is unavailable; reinstall the agent-swarm skill"
        ) from exc
    if manifest.get("schema_version") != 1:
        raise RuntimeError(
            "bundled ACP runtime manifest is unsupported; reinstall the agent-swarm skill"
        )
    return manifest


def _is_musl():
    libc, _ = platform.libc_ver()
    if libc.lower() == "musl" or pathlib.Path("/etc/alpine-release").exists():
        return True
    return any(pathlib.Path("/lib").glob("ld-musl-*.so*"))


def _bundle_key():
    if sys.implementation.name != "cpython" or sys.version_info.major != 3:
        raise RuntimeError("bundled ACP runtime requires CPython 3.10-3.14")
    minor = sys.version_info.minor
    if minor not in SUPPORTED_MINORS:
        raise RuntimeError("bundled ACP runtime requires CPython 3.10-3.14")
    machine = platform.machine().lower()
    if machine in {"arm64", "aarch64"}:
        architecture = "arm64"
    elif machine in {"x86_64", "amd64"}:
        architecture = "x86_64"
    else:
        raise RuntimeError(
            "bundled ACP runtime does not support architecture %s" % machine
        )
    system = platform.system().lower()
    if system == "darwin":
        target = "macos-%s" % architecture
    elif system == "linux":
        target = "linux-%s-%s" % (
            "musl" if _is_musl() else "gnu",
            architecture,
        )
    else:
        raise RuntimeError(
            "bundled ACP runtime supports macOS and Linux; got %s" % system
        )
    return "cp3%d-%s" % (minor, target)


def _cache_root(override=None):
    if override is not None:
        return pathlib.Path(override).resolve()
    configured = os.environ.get(CACHE_ENV, "").strip()
    if configured:
        return pathlib.Path(configured).expanduser().resolve()
    runtime = os.environ.get("AGENT_SWARM_HOME", "").strip()
    base = (
        pathlib.Path(runtime).expanduser()
        if runtime
        else pathlib.Path.home() / ".agent-swarm"
    )
    return base.resolve() / "dependencies" / "acp-runtime"


def _verified_archive(entry):
    path = (BUNDLE_DIR / entry["file"]).resolve()
    try:
        path.relative_to(BUNDLE_DIR.resolve())
    except ValueError as exc:
        raise RuntimeError("bundled ACP runtime manifest contains an unsafe path") from exc
    if not path.is_file() or _digest(path) != entry["sha256"]:
        raise RuntimeError(
            "bundled ACP runtime archive is corrupt; reinstall the agent-swarm skill"
        )
    return path


def _safe_extract(archive_path, destination):
    destination.mkdir(mode=0o700)
    root = destination.resolve()
    with zipfile.ZipFile(archive_path) as archive:
        for info in archive.infolist():
            target = (destination / info.filename).resolve()
            try:
                target.relative_to(root)
            except ValueError as exc:
                raise RuntimeError("bundled ACP runtime contains an unsafe path") from exc
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output)


def _activate_native(manifest, key, cache_root):
    if fcntl is None:
        raise RuntimeError("bundled ACP runtime requires macOS or Linux")
    entry = manifest.get("native", {}).get(key)
    if not entry:
        raise RuntimeError(
            "bundled ACP runtime has no payload for %s; reinstall the agent-swarm skill"
            % key
        )
    archive_path = _verified_archive(entry)
    cache_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = cache_root / (key + ".lock")
    with lock_path.open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        target = cache_root / (key + "-" + entry["sha256"][:16])
        marker = target / ".complete"
        if marker.is_file() and marker.read_text(encoding="ascii") == entry["sha256"]:
            return target
        if target.exists():
            shutil.rmtree(target)
        temporary = pathlib.Path(
            tempfile.mkdtemp(prefix=key + ".", dir=str(cache_root))
        )
        try:
            _safe_extract(archive_path, temporary / "payload")
            (temporary / "payload" / ".complete").write_text(
                entry["sha256"], encoding="ascii"
            )
            try:
                os.replace(temporary / "payload", target)
            except OSError:
                if not marker.is_file():
                    raise
            return target
        finally:
            shutil.rmtree(temporary, ignore_errors=True)


def activate(cache_root=None):
    """Inject the verified official SDK bundle into this interpreter."""
    manifest = _read_manifest()
    pure_archive = _verified_archive(manifest["pure"])
    key = _bundle_key()
    native = _activate_native(manifest, key, _cache_root(cache_root))
    for entry in (str(pure_archive), str(native)):
        if entry in sys.path:
            sys.path.remove(entry)
        sys.path.insert(0, entry)
    return {
        "source": "bundled",
        "key": key,
        "packages": dict(manifest["packages"]),
        "cache": str(native),
    }
