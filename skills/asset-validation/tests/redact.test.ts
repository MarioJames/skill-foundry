import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emit } from "../scripts/acc.ts";
import * as db from "../scripts/db.ts";
import { redactSecrets } from "../scripts/redact.ts";
import * as rounds from "../scripts/rounds.ts";
import { textLength } from "../scripts/text-utils.ts";

const TOKEN = "as_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("secret redaction", () => {
  test("counts Unicode code points like Python len", () => {
    expect(textLength("😀中")).toBe(2);
  });

  test("redacts actor tokens in keyed and bare forms", () => {
    const source = `{"actor_token":"${TOKEN}","AGENTS_ORCHESTRATOR_ACTOR_TOKEN":"${TOKEN}"} shell=${TOKEN}`;
    const output = redactSecrets(source);
    expect(output).not.toContain(TOKEN);
    expect(output.match(/<redacted>/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  test("redacts structured CLI output", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      emit({ transcript: `actor_token: "${TOKEN}"` });
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]?.[0])).not.toContain(TOKEN);
    } finally {
      log.mockRestore();
    }
  });

  test("sanitizes legacy round evidence before reads", () => {
    const temporary = mkdtempSync(join(tmpdir(), "acc-redact-"));
    temporaryPaths.push(temporary);
    const previous = process.env.ACCEPTANCE_HOME;
    process.env.ACCEPTANCE_HOME = temporary;
    let connection: db.Connection | undefined;
    try {
      connection = db.connect();
      db.run(
        connection,
        "INSERT INTO asset(id,name,type,source_path,created_at) VALUES (?,?,?,?,?)",
        ["asset_test", "test", "skill", temporary, db.now()],
      );
      db.run(
        connection,
        "INSERT INTO acceptance(id,asset_id,goal,status,created_at,updated_at) "
          + "VALUES (?,?,?,?,?,?)",
        ["acc_test", "asset_test", "test", "active", db.now(), db.now()],
      );
      db.run(
        connection,
        "INSERT INTO round(id,acceptance_id,round_tag,mode,verdict,transcript,started_at) "
          + "VALUES (?,?,?,?,?,?,?)",
        ["round_test", "acc_test", "1-test", "stop-loss", "FAIL", TOKEN, db.now()],
      );
      expect(rounds.redactPersistedEvidence(connection)).toBe(1);
      const stored = db.get<{ transcript: string }>(
        connection,
        "SELECT transcript FROM round WHERE id='round_test'",
      );
      expect(stored?.transcript).not.toContain(TOKEN);
      expect(rounds.redactPersistedEvidence(connection)).toBe(0);
    } finally {
      connection?.close();
      if (previous === undefined) {
        delete process.env.ACCEPTANCE_HOME;
      } else {
        process.env.ACCEPTANCE_HOME = previous;
      }
    }
  });
});
