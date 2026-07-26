import pathlib
import re
import unittest


SKILL_DIR = pathlib.Path(__file__).resolve().parents[1]
SKILL_PATH = SKILL_DIR / "SKILL.md"


def frontmatter(path):
    text = path.read_text(encoding="utf-8")
    match = re.match(r"\A---\n(?P<body>.*?)\n---\n", text, re.DOTALL)
    if not match:
        raise AssertionError("missing YAML frontmatter")
    result = {}
    for line in match.group("body").splitlines():
        key, value = line.split(":", 1)
        result[key.strip()] = value.strip()
    return result


class TriggerBoundaryStaticTests(unittest.TestCase):
    def test_canonical_frontmatter_is_explicit_only(self):
        metadata = frontmatter(SKILL_PATH)
        self.assertEqual({"name", "description"}, set(metadata))
        self.assertEqual("agents-orchestrator", metadata["name"])

        description = metadata["description"].lower()
        for activation in (
            "$agents-orchestrator",
            "swarm mode",
            "loop mode",
            "multi-agent review",
            "multi-agent plan review",
            "agent-swarm",
            "agent swarm",
            "agentswram",
            "蜂群模式",
            "[orchestration identity]",
        ):
            self.assertIn(activation, description)
        for boundary in (
            "use only when the user explicitly asks",
            "ordinary reviews",
            "paths or links",
            "quoted or example mentions",
            "explain, inspect, edit, rename, or optimize",
        ):
            self.assertIn(boundary, description)

    def test_product_metadata_disables_implicit_invocation(self):
        metadata = (SKILL_DIR / "agents" / "openai.yaml").read_text(encoding="utf-8")
        self.assertIn('default_prompt: "Use $agents-orchestrator', metadata)
        self.assertRegex(metadata, r"(?m)^\s+allow_implicit_invocation: false$")

    def test_skill_is_concise_and_routes_details_one_level_down(self):
        text = SKILL_PATH.read_text(encoding="utf-8")
        self.assertLessEqual(len(text.splitlines()), 100)
        references = set(re.findall(r"\(references/([a-z0-9-]+\.md)\)", text))
        self.assertEqual(
            {
                "runtime-contract.md",
                "action-schemas.md",
                "operating-modes.md",
                "review-consensus.md",
                "recovery-protocol.md",
                "acp-sdk.md",
            },
            references,
        )
        for reference in references:
            self.assertTrue((SKILL_DIR / "references" / reference).is_file())

    def test_requested_examples_and_evidence_guard_are_present(self):
        modes = (SKILL_DIR / "references" / "operating-modes.md").read_text(
            encoding="utf-8"
        )
        review = (SKILL_DIR / "references" / "review-consensus.md").read_text(
            encoding="utf-8"
        )
        recovery = (SKILL_DIR / "references" / "recovery-protocol.md").read_text(
            encoding="utf-8"
        )
        for example in (
            "## Swarm",
            "## Develop-review-improve loop",
            "## Swarm to loop to review",
            "## Legacy `agent-swarm` alias",
        ):
            self.assertIn(example, modes)
        self.assertIn("dependency edges gate scheduling", modes)
        self.assertIn("dependency_evidence_bundle", modes)
        self.assertIn("12,000 bytes", modes)
        self.assertIn("--type start_mode --stdin", modes)
        self.assertIn("--type advance_mode --stdin", modes)
        self.assertIn("`multi_session_review` is an ACP-only", review)
        self.assertIn("Multi-Agent plan review", review)
        self.assertIn("--type start_mode --stdin", review)
        for command in (" recover ", " reap ", " stop "):
            self.assertIn(command, recovery)

    def test_repository_contains_no_offline_acp_dependency_bundle(self):
        self.assertFalse((SKILL_DIR / "assets" / "acp-runtime").exists())
        self.assertFalse(
            (SKILL_DIR / "scripts" / "build_acp_runtime_bundle.py").exists()
        )
        sdk = (SKILL_DIR / "references" / "acp-sdk.md").read_text(encoding="utf-8")
        self.assertIn("first ACP initialization", sdk)
        self.assertIn(".agents-orchestrator/dependencies", sdk)
        self.assertNotIn("pure.zip", sdk)


if __name__ == "__main__":
    unittest.main()
