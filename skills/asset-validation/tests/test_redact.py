import contextlib
import io
import os
import pathlib
import sys
import tempfile
import unittest


SKILL_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(SKILL_DIR) not in sys.path:
    sys.path.insert(0, str(SKILL_DIR))

from scripts import acc, db, redact, rounds


TOKEN = "as_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"


class RedactionTests(unittest.TestCase):
    def test_actor_token_is_redacted_in_keyed_and_bare_forms(self):
        source = (
            '{"actor_token":"%s","AGENT_SWARM_ACTOR_TOKEN":"%s"} '
            "shell=%s" % (TOKEN, TOKEN, TOKEN)
        )
        output = redact.redact_secrets(source)
        self.assertNotIn(TOKEN, output)
        self.assertGreaterEqual(output.count("<redacted>"), 3)

    def test_emit_redacts_structured_cli_output(self):
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            acc._emit({"transcript": 'actor_token: "%s"' % TOKEN})
        self.assertNotIn(TOKEN, stream.getvalue())

    def test_legacy_round_evidence_is_sanitized_before_read(self):
        with tempfile.TemporaryDirectory() as temporary:
            previous = os.environ.get("ACCEPTANCE_HOME")
            os.environ["ACCEPTANCE_HOME"] = temporary
            try:
                con = db.connect()
                con.execute(
                    "INSERT INTO asset(id,name,type,source_path,created_at) "
                    "VALUES ('asset_test','test','skill',?,?)",
                    (temporary, db.now()),
                )
                con.execute(
                    "INSERT INTO acceptance(id,asset_id,goal,status,created_at,updated_at) "
                    "VALUES ('acc_test','asset_test','test','active',?,?)",
                    (db.now(), db.now()),
                )
                con.execute(
                    "INSERT INTO round(id,acceptance_id,round_tag,mode,verdict," 
                    "transcript,started_at) VALUES "
                    "('round_test','acc_test','1-test','stop-loss','FAIL',?,?)",
                    (TOKEN, db.now()),
                )
                con.commit()
                self.assertEqual(rounds.redact_persisted_evidence(con), 1)
                stored = con.execute(
                    "SELECT transcript FROM round WHERE id='round_test'"
                ).fetchone()[0]
                self.assertNotIn(TOKEN, stored)
                self.assertEqual(rounds.redact_persisted_evidence(con), 0)
                con.close()
            finally:
                if previous is None:
                    os.environ.pop("ACCEPTANCE_HOME", None)
                else:
                    os.environ["ACCEPTANCE_HOME"] = previous


if __name__ == "__main__":
    unittest.main()
