import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../../skills/herdr/scripts/name-tab.ts");
const threadId = "01a1df81-8b66-76f2-b2dd-50c89f35e7ce";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Fake herdr and codex executables. `owner` decides which pid the pane reports as foreground:
 * this test process (an ancestor of name-tab.ts), or init. `lostAfter` switches it to init after
 * that many process-info reads, as if the pane changed hands between proof and write.
 */
function run(options: { owner: boolean; lostAfter?: number; env?: Record<string, string> }) {
  const root = mkdtempSync(join(tmpdir(), "herdr-name-tab-test-"));
  roots.push(root);
  const state = join(root, "state.json");
  writeFileSync(state, JSON.stringify({ calls: [], label: "old", reads: 0 }));
  const fake = (name: string, body: string) => {
    writeFileSync(join(root, name), `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const s = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));
const a = process.argv.slice(2); s.calls.push([${JSON.stringify(name)}, ...a]);
const out = v => { writeFileSync(${JSON.stringify(state)}, JSON.stringify(s)); console.log(JSON.stringify(v)); };
${body}
`);
    chmodSync(join(root, name), 0o755);
  };
  const pane = { workspace_id: "w2", tab_id: "w2:t1", pane_id: "w2:p1", terminal_id: "term-1" };
  fake("herdr", `
const pane = ${JSON.stringify(pane)};
if (a[0] === "pane" && a[1] === "current") out({ result: { pane } });
else if (a[0] === "pane" && a[1] === "process-info") {
  s.reads += 1;
  const lost = ${options.lostAfter ?? 0} > 0 && s.reads > ${options.lostAfter ?? 0};
  out({ result: { process_info: { pane_id: pane.pane_id, foreground_processes: [{ pid: ${options.owner} && !lost ? ${process.pid} : 1 }] } } });
} else if (a[0] === "tab" && a[1] === "get") out({ result: { tab: { tab_id: pane.tab_id, workspace_id: pane.workspace_id, label: s.label } } });
else if (a[0] === "tab" && a[1] === "rename") { s.label = a[3]; out({ type: "ok" }); }
else if (a[0] === "agent" && a[1] === "list") out({ result: { agents: [] } });
else { out({}); process.exit(1); }`);
  // A daemon reported as running whose socket does not exist: any use of it fails.
  fake("codex", `out({ status: "running", socketPath: ${JSON.stringify(join(root, "missing.sock"))} });`);
  const child = Bun.spawnSync([process.execPath, script, "--label", "1115｜FIX｜归属"], {
    env: { PATH: `${root}:${process.env.PATH}`, HOME: root, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const after = JSON.parse(readFileSync(state, "utf8"));
  return { code: child.exitCode, json: JSON.parse(child.stdout.toString()), calls: after.calls as string[][], label: after.label as string };
}

test("a Codex TUI proven by process ancestry is labelled even while an unrelated daemon runs", () => {
  const result = run({ owner: true, env: { CODEX_THREAD_ID: threadId } });
  expect(result.json).toMatchObject({ ok: true, tab: { proof: "process-ancestry", changed: true } });
  expect(result.label).toBe("1115｜FIX｜归属");
  expect(result.calls.some((call) => call[0] === "codex")).toBe(false);
});

test("an unproven caller without a Codex thread changes no tab", () => {
  const result = run({ owner: false });
  expect(result.code).toBe(1);
  expect(result.json.error.code).toBe("unverified_caller");
  expect(result.label).toBe("old");
});

test("ownership lost between proof and write stops without falling back to a challenge", () => {
  const result = run({ owner: true, lostAfter: 1, env: { CODEX_THREAD_ID: threadId } });
  expect(result.code).toBe(1);
  expect(result.label).toBe("old");
  expect(result.calls.some((call) => call[0] === "codex")).toBe(false);
});
