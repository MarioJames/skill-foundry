import atexit
import contextlib
import json
import os
import pathlib
import sys
import tempfile
import shutil
from unittest import mock


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

# A repository test process may itself be an orchestrated child.  Never let
# that parent identity or configuration leak into isolated Runtime fixtures.
ORCHESTRATION_PREFIXES = ("AGENTS_ORCHESTRATOR_", "AGENT_SWARM_")
for _name in tuple(os.environ):
    if _name.startswith(ORCHESTRATION_PREFIXES):
        os.environ.pop(_name, None)

_DEPENDENCY_HOME = pathlib.Path(
    tempfile.mkdtemp(prefix="agents-orchestrator-test-dependencies-", dir="/tmp")
)
os.environ.setdefault("AGENTS_ORCHESTRATOR_DEPENDENCY_HOME", str(_DEPENDENCY_HOME))
os.environ.setdefault("AGENT_SWARM_DEPENDENCY_HOME", str(_DEPENDENCY_HOME))
atexit.register(shutil.rmtree, _DEPENDENCY_HOME, ignore_errors=True)

from backends.acp.dependencies import activate as activate_managed_sdk

activate_managed_sdk()


def _seed_default_managed_agents():
    from backends.acp import dependencies, registry

    def fake_installer(target, requirement, environment):
        return "test", ["test-installer", str(target), requirement]

    def fake_install(command, **kwargs):
        target = pathlib.Path(command[1])
        package, version = command[2].rsplit("@", 1)
        executable_by_package = {
            "@agentclientprotocol/codex-acp": "codex-acp",
            "@agentclientprotocol/claude-agent-acp": "claude-agent-acp",
        }
        package_dir = target / "node_modules" / pathlib.Path(*package.split("/"))
        package_dir.mkdir(parents=True, exist_ok=True)
        (package_dir / "package.json").write_text(
            json.dumps({"name": package, "version": version}) + "\n"
        )
        executable = target / "node_modules" / ".bin" / executable_by_package[package]
        executable.parent.mkdir(parents=True, exist_ok=True)
        executable.write_text("#!/bin/sh\nexit 0\n")
        executable.chmod(0o700)

    environment = {
        "HOME": str(_DEPENDENCY_HOME),
        "PATH": "",
        "AGENTS_ORCHESTRATOR_DEPENDENCY_HOME": str(_DEPENDENCY_HOME),
        "AGENT_SWARM_DEPENDENCY_HOME": str(_DEPENDENCY_HOME),
    }
    with mock.patch.object(
        dependencies, "_agent_installer", side_effect=fake_installer
    ), mock.patch.object(dependencies, "_run_install", side_effect=fake_install):
        registry.install_default_profiles(environment=environment)


_seed_default_managed_agents()


@contextlib.contextmanager
def isolated_runtime():
    with tempfile.TemporaryDirectory(prefix="agent-swarm-test-", dir="/tmp") as temporary:
        runtime_home = pathlib.Path(temporary) / "runtime"
        cwd = pathlib.Path(temporary) / "workspace"
        cwd.mkdir()
        environment = {
            name: value
            for name, value in os.environ.items()
            if not name.startswith(ORCHESTRATION_PREFIXES)
        }
        environment.update(
            {
                "AGENTS_ORCHESTRATOR_HOME": str(runtime_home),
                "AGENT_SWARM_HOME": str(runtime_home),
                "AGENTS_ORCHESTRATOR_DEPENDENCY_HOME": str(_DEPENDENCY_HOME),
                "AGENT_SWARM_DEPENDENCY_HOME": str(_DEPENDENCY_HOME),
            }
        )
        with mock.patch.dict(
            os.environ,
            environment,
            clear=True,
        ):
            yield runtime_home, cwd


def insert_ready_child(con, run, *, task_id=None):
    now = __import__("state_store").now()
    if task_id is not None and (isinstance(task_id, bool) or not isinstance(task_id, int)):
        raise ValueError("task_id must be an integer")
    cursor = con.execute(
        """INSERT INTO tasks(
             root_id, parent_task_id, goal, intent_hint, status, priority,
             complexity_hint, output_contract, constraints_json, delegation_depth,
             replan_count, created_at
           ) VALUES (?, ?, 'child goal', 'implement', 'ready', 50,
                     'medium', 'finish child', '{}', 1, 0, ?)""",
        (run["root_id"], run["root_task_id"], now),
    )
    return cursor.lastrowid


def json_column(row, key):
    return json.loads(row[key])
