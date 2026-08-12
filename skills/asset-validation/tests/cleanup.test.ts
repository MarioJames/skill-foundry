import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as catalog from "../scripts/catalog.ts";
import * as db from "../scripts/db.ts";
import { cleanupSandbox, removeTreeRetry } from "../scripts/envprep.ts";
import * as rounds from "../scripts/rounds.ts";

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("sandbox cleanup boundaries", () => {
  test("removes recorded nested acc sandboxes without glob-cleaning siblings", () => {
    const root = mkdtempSync(join(tmpdir(), "acc-cleanup-"));
    temporaryPaths.push(root);
    const parent = join(root, "acc-parent");
    const nested = join(parent, "acc-nested");
    const sibling = join(root, "unrelated-sibling");
    mkdirSync(nested, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    const previous = process.env.ACCEPTANCE_HOME;
    process.env.ACCEPTANCE_HOME = join(parent, ".aut-acceptance");
    let connection: db.Connection | undefined;
    try {
      connection = db.connect();
      const assetId = catalog.addAsset(connection, "nested", "skill", parent);
      const acceptanceId = catalog.newAcceptance(connection, assetId, "goal");
      rounds.startRound(connection, acceptanceId, {
        mode: "stop-loss",
        n: 1,
        sandboxPath: nested,
      });
    } finally {
      connection?.close();
      if (previous === undefined) delete process.env.ACCEPTANCE_HOME;
      else process.env.ACCEPTANCE_HOME = previous;
    }
    const result = cleanupSandbox(parent);
    expect(result.existed).toBe(true);
    expect(result.nested_sandboxes).toHaveLength(1);
    expect(result.nested_sandboxes[0]?.path).toBe(nested);
    expect(existsSync(parent)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  test("retries an exact cleanup target that reappears after a successful remove", () => {
    let present = true;
    let removes = 0;
    const waits: number[] = [];
    removeTreeRetry("/tmp/acc-test-reappears", 4, {
      remove: () => {
        removes += 1;
        present = removes === 1;
      },
      exists: () => present,
      sleep: (seconds) => waits.push(seconds),
    });
    expect(removes).toBe(2);
    expect(waits).toEqual([0.1, 0.2]);
  });

  test("fails loudly when a cleanup target keeps reappearing", () => {
    expect(() => removeTreeRetry("/tmp/acc-test-persistent", 2, {
      remove: () => {},
      exists: () => true,
      sleep: () => {},
    })).toThrow("cleanup target reappeared after 2 attempts");
  });
});
