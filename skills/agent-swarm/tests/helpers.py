import contextlib
import json
import os
import pathlib
import sys
import tempfile
from unittest import mock


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


@contextlib.contextmanager
def isolated_runtime():
    with tempfile.TemporaryDirectory(prefix="agent-swarm-test-", dir="/tmp") as temporary:
        runtime_home = pathlib.Path(temporary) / "runtime"
        cwd = pathlib.Path(temporary) / "workspace"
        cwd.mkdir()
        with mock.patch.dict(
            os.environ,
            {
                "AGENT_SWARM_HOME": str(runtime_home),
                "AGENT_SWARM_BACKEND": "",
                "AGENT_SWARM_ACP_AGENT": "",
                "AGENT_SWARM_ACP_COMMAND": "",
                "AGENT_SWARM_ACP_ARGS": "",
                "AGENT_SWARM_ACP_PERMISSION_POLICY": "",
                "AGENT_SWARM_CLAUDE_BIN": "",
            },
            clear=False,
        ):
            yield runtime_home, cwd


def insert_ready_child(con, run, *, task_id="task_child"):
    now = __import__("state_store").now()
    con.execute(
        """INSERT INTO tasks(
             task_id, root_id, parent_task_id, goal, intent_hint, status, priority,
             complexity_hint, output_contract, constraints_json, delegation_depth,
             replan_count, created_at
           ) VALUES (?, ?, ?, 'child goal', 'implement', 'ready', 50,
                     'medium', 'finish child', '{}', 1, 0, ?)""",
        (task_id, run["root_id"], run["root_task_id"], now),
    )
    return task_id


def json_column(row, key):
    return json.loads(row[key])
