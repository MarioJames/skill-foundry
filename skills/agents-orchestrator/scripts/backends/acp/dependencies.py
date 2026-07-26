"""First-use installation of pinned ACP SDK and Agent dependencies."""

from contextlib import contextmanager
import hashlib
import importlib
import importlib.metadata
import json
import os
import pathlib
import platform
import shutil
import subprocess
import sys
import tempfile

import compat_env

try:
    import fcntl
except ImportError:  # Windows is outside the v1 Unix-socket support boundary.
    fcntl = None


SDK_DISTRIBUTION = "agent-client-protocol"
SDK_VERSION = "0.11.0"
SDK_PACKAGES = {
    "agent-client-protocol": "0.11.0",
    "annotated-types": "0.8.0",
    "pydantic": "2.13.4",
    "pydantic-core": "2.46.4",
    "typing-extensions": "4.16.0",
    "typing-inspection": "0.4.2",
}
SDK_REQUIREMENTS = tuple(
    "%s==%s" % (name, version) for name, version in SDK_PACKAGES.items()
)
SDK_REQUIREMENT = "%s==%s" % (SDK_DISTRIBUTION, SDK_VERSION)
SUPPORTED_MINORS = {10, 11, 12, 13, 14}
MARKER_NAME = ".agents-orchestrator-install.json"
INSTALL_SCHEMA_VERSION = 1


def _normalize_distribution(name):
    return str(name or "").strip().lower().replace("_", "-").replace(".", "-")


def _dependency_home(override=None, environment=None):
    if override is not None:
        return pathlib.Path(override).expanduser().resolve()
    environment = os.environ if environment is None else environment
    configured = compat_env.value("DEPENDENCY_HOME", environment)
    deprecated = compat_env.value("ACP_BUNDLE_CACHE", environment)
    if configured and deprecated:
        configured_path = pathlib.Path(configured).expanduser().resolve()
        deprecated_path = pathlib.Path(deprecated).expanduser().resolve()
        if configured_path != deprecated_path:
            raise ValueError(
                "conflicting dependency homes: DEPENDENCY_HOME and deprecated "
                "ACP_BUNDLE_CACHE"
            )
    selected = configured or deprecated
    if selected:
        return pathlib.Path(selected).expanduser().resolve()
    home = pathlib.Path(environment.get("HOME") or pathlib.Path.home()).expanduser()
    return (home / ".agents-orchestrator" / "dependencies").resolve()


def _runtime_key():
    if sys.implementation.name != "cpython" or sys.version_info.major != 3:
        raise RuntimeError("ACP Python SDK requires CPython 3.10-3.14")
    if sys.version_info.minor not in SUPPORTED_MINORS:
        raise RuntimeError("ACP Python SDK requires CPython 3.10-3.14")
    system = platform.system().lower()
    if system not in {"darwin", "linux"}:
        raise RuntimeError("Agents Orchestrator ACP requires macOS or Linux")
    machine = platform.machine().lower()
    libc = platform.libc_ver()[0].lower() if system == "linux" else ""
    parts = [sys.implementation.cache_tag, system, machine]
    if libc:
        parts.append(libc)
    return "-".join(parts)


def _requirements_digest(requirements):
    payload = "\n".join(requirements).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]


def _ensure_private_directory(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.chmod(0o700)
    except OSError:
        pass


@contextmanager
def _install_lock(root, name):
    if fcntl is None:
        raise RuntimeError("automatic dependency installation requires macOS or Linux")
    _ensure_private_directory(root)
    lock_path = root / (name + ".lock")
    descriptor = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        yield


def _read_marker(target):
    try:
        return json.loads((target / MARKER_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_marker(target, payload):
    (target / MARKER_NAME).write_text(
        json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _installed_versions(target):
    versions = {}
    try:
        distributions = importlib.metadata.distributions(path=[str(target)])
        for distribution in distributions:
            name = _normalize_distribution(distribution.metadata.get("Name"))
            if name:
                versions[name] = distribution.version
    except (OSError, ValueError):
        return {}
    return versions


def _sdk_ready(target, runtime_key):
    marker = _read_marker(target)
    expected_marker = {
        "schema_version": INSTALL_SCHEMA_VERSION,
        "kind": "python-sdk",
        "runtime_key": runtime_key,
        "requirements": list(SDK_REQUIREMENTS),
    }
    if not marker or any(marker.get(key) != value for key, value in expected_marker.items()):
        return False
    versions = _installed_versions(target)
    if any(versions.get(name) != version for name, version in SDK_PACKAGES.items()):
        return False
    return (target / "acp" / "__init__.py").is_file()


def _python_installer(target, environment):
    uv = shutil.which("uv", path=environment.get("PATH"))
    if uv:
        return "uv", [
            uv,
            "--no-config",
            "--no-python-downloads",
            "--no-cache",
            "--quiet",
            "pip",
            "install",
            "--python",
            sys.executable,
            "--target",
            str(target),
            "--no-deps",
            "--only-binary",
            ":all:",
            *SDK_REQUIREMENTS,
        ]
    return "pip", [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--no-cache-dir",
        "--no-deps",
        "--only-binary=:all:",
        "--target",
        str(target),
        *SDK_REQUIREMENTS,
    ]


def _run_install(command, *, environment, timeout, label, manual_hint):
    try:
        completed = subprocess.run(
            command,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=timeout,
            env=dict(environment),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(
            "automatic %s installation could not run; %s" % (label, manual_hint)
        ) from exc
    if completed.returncode != 0:
        raise RuntimeError(
            "automatic %s installation failed via %s (exit %d); %s"
            % (label, pathlib.Path(command[0]).name, completed.returncode, manual_hint)
        )


def _install_sdk(target, root, runtime_key, environment):
    temporary = pathlib.Path(tempfile.mkdtemp(prefix="sdk.", dir=str(root)))
    payload = temporary / "site-packages"
    payload.mkdir(mode=0o700)
    try:
        installer, command = _python_installer(payload, environment)
        _run_install(
            command,
            environment=environment,
            timeout=240,
            label="ACP Python SDK",
            manual_hint=(
                "ensure network access and install uv or pip, then retry the skill"
            ),
        )
        versions = _installed_versions(payload)
        if any(versions.get(name) != version for name, version in SDK_PACKAGES.items()):
            raise RuntimeError("automatic ACP Python SDK installation produced unexpected versions")
        if not (payload / "acp" / "__init__.py").is_file():
            raise RuntimeError("automatic ACP Python SDK installation is incomplete")
        _write_marker(
            payload,
            {
                "schema_version": INSTALL_SCHEMA_VERSION,
                "kind": "python-sdk",
                "runtime_key": runtime_key,
                "requirements": list(SDK_REQUIREMENTS),
                "installer": installer,
            },
        )
        if target.exists():
            shutil.rmtree(target)
        os.replace(str(payload), str(target))
        return installer
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def sdk_status(cache_root=None, environment=None):
    runtime_key = _runtime_key()
    dependency_home = _dependency_home(cache_root, environment)
    root = dependency_home / "python"
    target = root / (
        "acp-sdk-%s-%s" % (runtime_key, _requirements_digest(SDK_REQUIREMENTS))
    )
    marker = _read_marker(target)
    return {
        "available": _sdk_ready(target, runtime_key),
        "source": "managed",
        "target": str(target),
        "runtime_key": runtime_key,
        "requirements": list(SDK_REQUIREMENTS),
        "installer": marker.get("installer") if marker else None,
    }


def activate(cache_root=None, environment=None):
    """Install the pinned official SDK on first use and inject it into this process."""
    environment = os.environ if environment is None else environment
    status = sdk_status(cache_root, environment)
    target = pathlib.Path(status["target"])
    root = target.parent
    installed = False
    with _install_lock(root, "sdk"):
        if not _sdk_ready(target, status["runtime_key"]):
            _install_sdk(target, root, status["runtime_key"], environment)
            installed = True
        marker = _read_marker(target) or {}
    target_text = str(target)
    loaded = sys.modules.get("acp")
    if loaded is not None:
        loaded_path = pathlib.Path(getattr(loaded, "__file__", "")).resolve()
        try:
            loaded_path.relative_to(target.resolve())
        except (OSError, ValueError) as exc:
            raise RuntimeError(
                "ACP Python SDK is already loaded outside the managed dependency home; "
                "restart the process"
            ) from exc
    if target_text in sys.path:
        sys.path.remove(target_text)
    sys.path.insert(0, target_text)
    importlib.invalidate_caches()
    return {
        "source": "managed",
        "installed": installed,
        "installer": marker.get("installer"),
        "runtime_key": status["runtime_key"],
        "packages": dict(SDK_PACKAGES),
        "target": target_text,
    }


def _package_directory(target, package):
    parts = package.split("/")
    return target / "node_modules" / pathlib.Path(*parts)


def _agent_ready(target, profile):
    package = profile.get("package")
    version = profile.get("profile_version")
    requested_command = profile.get("requested_command") or profile.get("command")
    marker = _read_marker(target)
    expected = {
        "schema_version": INSTALL_SCHEMA_VERSION,
        "kind": "acp-agent",
        "agent": profile.get("agent"),
        "package": package,
        "version": version,
        "requested_command": requested_command,
    }
    if not marker or any(marker.get(key) != value for key, value in expected.items()):
        return False
    try:
        package_json = json.loads(
            (_package_directory(target, package) / "package.json").read_text(
                encoding="utf-8"
            )
        )
    except (OSError, ValueError):
        return False
    executable = target / "node_modules" / ".bin" / requested_command
    return package_json.get("version") == version and executable.is_file() and os.access(
        str(executable), os.X_OK
    )


def _agent_installer(target, requirement, environment):
    path = environment.get("PATH")
    bun = shutil.which("bun", path=path)
    if bun:
        return "bun", [
            bun,
            "add",
            "--cwd",
            str(target),
            "--exact",
            "--ignore-scripts",
            "--no-progress",
            "--no-summary",
            requirement,
        ]
    pnpm = shutil.which("pnpm", path=path)
    if pnpm:
        return "pnpm", [
            pnpm,
            "add",
            "--dir",
            str(target),
            "--save-exact",
            "--ignore-scripts",
            requirement,
        ]
    npm = shutil.which("npm", path=path)
    if npm:
        return "npm", [
            npm,
            "install",
            "--prefix",
            str(target),
            "--save-exact",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            requirement,
        ]
    raise RuntimeError(
        "automatic ACP Agent installation requires bun, pnpm, or npm in PATH"
    )


def _install_agent(target, root, profile, environment):
    temporary = pathlib.Path(tempfile.mkdtemp(prefix="agent.", dir=str(root)))
    package = profile["package"]
    version = profile["profile_version"]
    requirement = "%s@%s" % (package, version)
    requested_command = profile.get("requested_command") or profile["command"]
    (temporary / "package.json").write_text(
        json.dumps(
            {
                "name": "agents-orchestrator-managed-%s" % profile["agent"],
                "private": True,
                "version": "0.0.0",
            },
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    try:
        manager, command = _agent_installer(temporary, requirement, environment)
        _run_install(
            command,
            environment=environment,
            timeout=300,
            label="%s ACP Agent" % profile["agent"],
            manual_hint="run `%s` and retry" % profile["install_hint"],
        )
        _write_marker(
            temporary,
            {
                "schema_version": INSTALL_SCHEMA_VERSION,
                "kind": "acp-agent",
                "agent": profile["agent"],
                "package": package,
                "version": version,
                "requested_command": requested_command,
                "installer": manager,
            },
        )
        if not _agent_ready(temporary, profile):
            raise RuntimeError(
                "automatic %s ACP Agent installation is incomplete" % profile["agent"]
            )
        if target.exists():
            shutil.rmtree(target)
        os.replace(str(temporary), str(target))
        return manager
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def install_agent(profile, *, environment=None, dependency_home=None):
    """Return a profile whose pinned built-in executable is runtime-managed."""
    if not profile.get("package") or profile.get("agent") == "custom":
        return dict(profile)
    if profile.get("command_override"):
        return dict(profile)
    environment = os.environ if environment is None else environment
    dependency_home = _dependency_home(dependency_home, environment)
    root = dependency_home / "agents"
    requested_command = profile.get("requested_command") or profile["command"]
    requirement = "%s@%s" % (profile["package"], profile["profile_version"])
    target = root / (
        "%s-%s-%s"
        % (
            profile["agent"],
            profile["profile_version"],
            _requirements_digest((requirement, requested_command)),
        )
    )
    candidate = dict(profile)
    candidate["requested_command"] = requested_command
    with _install_lock(root, "agent-%s" % profile["agent"]):
        if not _agent_ready(target, candidate):
            _install_agent(target, root, candidate, environment)
        marker = _read_marker(target) or {}
    executable = target / "node_modules" / ".bin" / requested_command
    result = dict(profile)
    result["requested_command"] = requested_command
    result["command"] = str(executable)
    result["managed_install"] = {
        "source": "managed",
        "dependency_home": str(dependency_home),
        "requirement": requirement,
        "installer": marker.get("installer"),
    }
    return result
