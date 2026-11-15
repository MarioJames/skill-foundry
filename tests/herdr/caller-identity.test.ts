import { expect, test } from "bun:test";
import { ancestorPids, ownsPane } from "../../skills/herdr/scripts/lib/caller-identity";

const pane = (pid: number) => ({ pane_id: "w1:p1", foreground_processes: [{ pid }] });

test("accepts the caller's actual foreground ancestor", () => {
  expect(ownsPane("w1:p1", pane(100), [200, 100, 50])).toBe(true);
});

test("rejects a different Agent even when the candidate pane ID matches", () => {
  expect(ownsPane("w1:p1", pane(300), [200, 100, 50])).toBe(false);
});

test("rejects a changed pane, missing evidence, and init PID", () => {
  expect(ownsPane("w2:p2", pane(100), [100])).toBe(false);
  expect(ownsPane("w1:p1", { pane_id: "w1:p1", shell_pid: 100 }, [100])).toBe(false);
  expect(ownsPane("w1:p1", pane(1), [1])).toBe(false);
});

test("reads the real parent independently of inherited pane/session variables", () => {
  expect(ancestorPids()).toContain(process.ppid);
});

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// "self": the resolver itself is the pane's foreground process, e.g. run directly in that pane's shell.
for (const owned of [true, "self", false] as const) {
  test(`automatic resolver ${owned === "self" ? "accepts running in the foreground itself" : owned ? "accepts its ancestor" : "rejects a foreign pane"} through CLI`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-caller-test-"));
    try {
      writeFileSync(join(dir, "herdr"), `#!/usr/bin/env bun
const pane = {workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p1'};
const result = process.argv[3] === 'current' ? {pane} : {
 process_info:{pane_id:pane.pane_id,foreground_processes:[{pid:${owned === "self" ? "process.ppid" : owned ? process.pid : 1}}]}
};
console.log(JSON.stringify({result}));
`, { mode: 0o755 });
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../skills/herdr/scripts/resolve-caller.ts")], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        Bun.readableStreamToText(child.stdout), Bun.readableStreamToText(child.stderr), child.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(owned ? 0 : 1);
      const result = JSON.parse(stdout);
      if (owned) expect(result.caller.paneId).toBe("w1:p1");
      else expect(result.error.code).toBe("unverified_caller");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
