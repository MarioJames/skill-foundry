import ast
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest


CANONICAL_DIR = pathlib.Path(__file__).resolve().parents[1]
ALIAS_DIR = CANONICAL_DIR.parent / "agent-swarm"
ALIAS_ENTRYPOINT = ALIAS_DIR / "scripts" / "agent_orchestrator.py"


class LegacyAliasStaticTests(unittest.TestCase):
    def test_alias_contains_only_metadata_and_one_thin_entrypoint(self):
        files = {
            path.relative_to(ALIAS_DIR).as_posix()
            for path in ALIAS_DIR.rglob("*")
            if path.is_file() and "__pycache__" not in path.parts
        }
        self.assertEqual(
            {"SKILL.md", "agents/openai.yaml", "scripts/agent_orchestrator.py"},
            files,
        )
        self.assertFalse((ALIAS_DIR / "assets").exists())
        self.assertFalse((ALIAS_DIR / "hooks").exists())
        self.assertFalse((ALIAS_DIR / "references").exists())

    def test_alias_execs_canonical_runtime_without_runtime_copy(self):
        source = ALIAS_ENTRYPOINT.read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported = {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        }
        self.assertEqual({"os", "pathlib", "sys"}, imported)
        self.assertIn('DEFAULT_MODE = "swarm"', source)
        self.assertIn('/ "agents-orchestrator"', source)
        self.assertIn('/ "scripts"', source)
        self.assertIn('/ "agent_orchestrator.py"', source)
        self.assertIn("os.execv", source)
        self.assertIn('sys.argv[1:2] == ["init"]', source)
        self.assertIn("has_injected_identity", source)
        self.assertNotIn("subprocess", source)
        self.assertNotRegex(source, r"\binit\s*\(")
        self.assertLess(len(source), 2000)
        self.assertGreater(
            (CANONICAL_DIR / "scripts" / "agent_orchestrator.py").stat().st_size,
            ALIAS_ENTRYPOINT.stat().st_size * 10,
        )

    def test_alias_metadata_is_explicit_and_points_to_canonical_skill(self):
        skill = (ALIAS_DIR / "SKILL.md").read_text(encoding="utf-8")
        self.assertRegex(skill, r"(?m)^name: agent-swarm$")
        self.assertIn("Legacy explicit-only alias", skill)
        self.assertIn("`../agents-orchestrator/SKILL.md`", skill)
        self.assertIn("default the requested recipe to `swarm`", skill)
        self.assertIn("never initialize a fallback Run", skill)
        self.assertIn("never\ncall `init`", skill)

        product = (ALIAS_DIR / "agents" / "openai.yaml").read_text(encoding="utf-8")
        self.assertIn('default_prompt: "Use $agent-swarm', product)
        self.assertRegex(product, r"(?m)^\s+allow_implicit_invocation: false$")

    def test_alias_entry_mode_is_consumed_once_by_the_canonical_init(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            workspace = root / "workspace"
            workspace.mkdir()
            runtime_home = root / "runtime"
            environment = {
                name: value
                for name, value in os.environ.items()
                if not name.startswith(("AGENTS_ORCHESTRATOR_", "AGENT_SWARM_"))
            }
            environment.update(
                {
                    "AGENTS_ORCHESTRATOR_HOME": str(runtime_home),
                    "AGENT_SWARM_HOME": str(runtime_home),
                }
            )
            completed = subprocess.run(
                [
                    sys.executable,
                    str(ALIAS_ENTRYPOINT),
                    "init",
                    "--task",
                    "legacy swarm entry",
                    "--cwd",
                    str(workspace),
                    "--backend",
                    "claude_cli",
                ],
                text=True,
                capture_output=True,
                check=False,
                env=environment,
            )
            self.assertEqual(0, completed.returncode, completed.stderr)
            self.assertEqual("swarm", json.loads(completed.stdout)["entry_mode"])

            environment["AGENTS_ORCHESTRATOR_MODE"] = "review"
            environment["AGENT_SWARM_MODE"] = "swarm"
            conflicted = subprocess.run(
                [sys.executable, str(ALIAS_ENTRYPOINT), "action-schema", "finish"],
                text=True,
                capture_output=True,
                check=False,
                env=environment,
            )
            self.assertNotEqual(0, conflicted.returncode)
            self.assertIn("conflicting orchestration environment", conflicted.stderr)


if __name__ == "__main__":
    unittest.main()
