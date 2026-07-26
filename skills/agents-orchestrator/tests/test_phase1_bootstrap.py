import contextlib
import io
import json
import os
import unittest
from unittest import mock

from helpers import insert_ready_child, isolated_runtime

import agent_orchestrator
import execution_secrets
import prompt_builder
import scheduler
import state_store


class Phase1BootstrapTests(unittest.TestCase):
    def test_claude_cli_prompt_still_requires_skill_read(self):
        with isolated_runtime() as (_, cwd):
            identity = agent_orchestrator.initialize_run(
                "root", str(cwd), backend="claude_cli"
            )
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            child = scheduler.schedule(identity["root_id"])[0]
            task = state_store.get_task(child["task_id"])
            attempt = state_store.get_attempt(child["attempt_id"])
            prompt = prompt_builder.build_prompt(run, task, attempt)

            self.assertIn('"$AGENT_SWARM_SKILL_DIR/SKILL.md"', prompt)

    def test_acp_prompt_uses_backend_neutral_bootstrap_contract(self):
        with isolated_runtime() as (_, cwd):
            identity = agent_orchestrator.initialize_run(
                "root",
                str(cwd),
                backend="acp",
                acp_agent="custom",
                acp_command="/absolute/fake-acp",
            )
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            child = scheduler.schedule(identity["root_id"])[0]
            task = state_store.get_task(child["task_id"])
            attempt = state_store.get_attempt(child["attempt_id"])
            prompt = prompt_builder.build_prompt(run, task, attempt)

            self.assertIn("bootstrap-cwd", prompt)
            self.assertNotIn("claude --bg", prompt)
            self.assertIn("never launch an Agent process directly", prompt)
            self.assertNotIn('"$AGENT_SWARM_SKILL_DIR/SKILL.md"', prompt)
            self.assertIn(
                "complete required Runtime protocol is included below",
                prompt,
            )
            self.assertIn("printf '%s' '<JSON object>' |", prompt)
            self.assertIn("action --type <ACTION_TYPE> --stdin", prompt)
            self.assertIn("action-schema <ACTION_TYPE>", prompt)

    def test_bootstrap_cwd_skips_hook_mutation_for_acp(self):
        with isolated_runtime() as (_, cwd):
            identity = agent_orchestrator.initialize_run(
                "root",
                str(cwd),
                backend="acp",
                acp_agent="custom",
                acp_command="/absolute/fake-acp",
            )
            with state_store.transaction() as con:
                run = state_store.get_run(identity["root_id"], con)
                insert_ready_child(con, run)
            child = scheduler.schedule(identity["root_id"])[0]
            run = state_store.get_run(identity["root_id"])
            token = execution_secrets.derive_attempt_token(run, child["attempt_id"])
            environment = {
                "AGENT_SWARM_ROOT_ID": identity["root_id"],
                "AGENT_SWARM_TASK_ID": str(child["task_id"]),
                "AGENT_SWARM_ATTEMPT_ID": str(child["attempt_id"]),
                "AGENT_SWARM_ACTOR_TOKEN": token,
            }
            output = io.StringIO()
            with mock.patch.dict(os.environ, environment, clear=False), mock.patch.object(
                agent_orchestrator.hook_manager, "ensure_project_hooks"
            ) as ensure_hooks, contextlib.redirect_stdout(output):
                result = agent_orchestrator.main(["bootstrap-cwd"])

            self.assertEqual(0, result)
            self.assertFalse(ensure_hooks.called)
            payload = json.loads(output.getvalue())
            self.assertTrue(payload["initialized"])
            self.assertFalse(payload["hooks_enabled"])


if __name__ == "__main__":
    unittest.main()
