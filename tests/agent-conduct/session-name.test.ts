import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claudeSessionCreatedAt,
  inheritedRunIdentity,
  nameCodexThread,
  nameLobehubTopic,
  sessionLabel,
  type ProcessChain,
} from "../../skills/agent-conduct/scripts/lib/session-name";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/agent-conduct/scripts/name-session.ts");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "session-name-test-"));
  roots.push(root);
  return root;
}

test("label uses creation date in Shanghai, not host timezone or update date", () => {
  expect(sessionLabel(Date.parse("2026-10-09T19:36:51Z"), "FIX", "会话归属")).toBe("1010｜FIX｜会话归属");
  expect(() => sessionLabel(Date.parse("2026-10-09T19:36:51Z"), "BAD", "会话归属")).toThrow();
  expect(() => sessionLabel(Date.parse("2026-10-09T19:36:51Z"), "FIX", "两行\n标题")).toThrow();
  expect(() => sessionLabel(Number.NaN, "FIX", "会话归属")).toThrow("createdAt");
});

// ---- LobeHub topic ----

const topicId = "tpc_owned";
const operationId = "op_current";
const ownerEnv = { LOBEHUB_TOPIC_ID: topicId, LOBEHUB_OPERATION_ID: operationId };

function fakeLh(topic: Record<string, any> = {}, options: { ignoreEdit?: boolean } = {}) {
  const calls: string[][] = [];
  const state = {
    id: topicId,
    title: "迁移会话命名逻辑至Agent Conduct",
    trigger: "task",
    createdAt: "2026-11-15T17:00:00.000Z",
    metadata: { taskId: "task_1", runningOperation: { operationId } },
    ...topic,
  };
  return {
    calls,
    lh: async (...args: string[]) => {
      calls.push(args);
      if (args[1] === "view") return JSON.stringify({ topic: state });
      if (args[1] === "edit") {
        if (!options.ignoreEdit) state.title = args[4];
        return "✓ Updated topic";
      }
      throw new Error(`unexpected lh ${args.join(" ")}`);
    },
  };
}
const edits = (calls: string[][]) => calls.filter((args) => args[1] === "edit");

test("the topic's running operation names it with the creation date and reads it back", async () => {
  const lh = fakeLh();
  const result = await nameLobehubTopic(lh.lh, ownerEnv, "FIX", "调度会话命名", false, null);
  expect(result).toMatchObject({ status: "named", label: "1116｜FIX｜调度会话命名", taskId: "task_1", trigger: "task" });
  expect(edits(lh.calls)).toEqual([["topic", "edit", topicId, "--title", "1116｜FIX｜调度会话命名"]]);
  expect(lh.calls.at(-1)?.[1]).toBe("view");
});

for (const [name, metadata] of [
  ["another operation drives the topic", { runningOperation: { operationId: "op_parent" } }],
  ["no operation is running", {}],
] as const) {
  test(`skips without writing when ${name}`, async () => {
    const lh = fakeLh({ metadata });
    const result = await nameLobehubTopic(lh.lh, ownerEnv, "FIX", "调度会话命名", false, null);
    expect(result).toMatchObject({ status: "skipped", reason: "not_running_operation" });
    expect(edits(lh.calls)).toHaveLength(0);
  });
}

test("refuses to write when LobeHub returns a different topic", async () => {
  const lh = fakeLh({ id: "tpc_other" });
  await expect(nameLobehubTopic(lh.lh, ownerEnv, "FIX", "调度会话命名", false, null)).rejects.toThrow("different topic");
  expect(edits(lh.calls)).toHaveLength(0);
});

test("dry-run and an already matching title do not write", async () => {
  for (const [dryRun, title] of [[true, "旧标题"], [false, "1116｜FIX｜调度会话命名"]] as const) {
    const lh = fakeLh({ title });
    await nameLobehubTopic(lh.lh, ownerEnv, "FIX", "调度会话命名", dryRun, null);
    expect(edits(lh.calls)).toHaveLength(0);
  }
});

test("a title that does not read back is reported without replaying the edit", async () => {
  const lh = fakeLh({}, { ignoreEdit: true });
  await expect(nameLobehubTopic(lh.lh, ownerEnv, "FIX", "调度会话命名", false, null)).rejects.toThrow("read-back");
  expect(edits(lh.calls)).toHaveLength(1);
});

// Process chains are innermost first: [this script, its shell, ..., init's child].
const mine = "2a71e054-96e5-4892-a1ee-997489b2beb6";
const codexThread = "01a1df81-8b66-76f2-b2dd-50c89f35e7ce";
const proc = (vars: Record<string, string>) => new Map(Object.entries(vars));
const op = { LOBEHUB_OPERATION_ID: operationId };

test("a LobeHub-started Claude Code run owns its operation", () => {
  const cc = { CLAUDE_CODE_SESSION_ID: mine };
  // bun, zsh tool shell, claude (started with the operation), LobeHub runner, lh connect
  const chain: ProcessChain = [proc({ ...op, ...cc }), proc({ ...op, ...cc }), proc(op), proc(op), proc({})];
  expect(inheritedRunIdentity({ ...op, ...cc }, chain, mine)).toBeNull();
  expect(inheritedRunIdentity({ ...op, ...cc }, chain, undefined)).toBeNull();
});

test("a Codex thread under a LobeHub app-server owns the operation set on its tool shell", () => {
  const cx = { CODEX_THREAD_ID: codexThread };
  const chain: ProcessChain = [proc({ ...op, ...cx }), proc({ ...op, ...cx }), proc({}), proc({})];
  expect(inheritedRunIdentity({ ...op, ...cx }, chain, codexThread)).toBeNull();
});

test("an agent in a terminal server started inside another LobeHub run does not own it", () => {
  const leaked = { ...op, CLAUDE_CODE_SESSION_ID: mine };
  const env = { ...leaked, CODEX_THREAD_ID: codexThread };
  // bun, Codex tool shell, codex, pane shell, herdr server (started from the Claude run), systemd
  const chain: ProcessChain = [proc(env), proc(env), proc(leaked), proc(leaked), proc(leaked), proc({})];
  expect(inheritedRunIdentity(env, chain, mine)).toBe("session_mismatch");
  // Before the topic records its agent session, the operation's reach gives it away.
  expect(inheritedRunIdentity(env, chain, undefined)).toBe("inherited_operation");
});

test("without /proc only a single recorded session can be compared", () => {
  expect(inheritedRunIdentity({ ...op, CODEX_THREAD_ID: codexThread }, null, mine)).toBe("session_mismatch");
  expect(inheritedRunIdentity({ ...op, CLAUDE_CODE_SESSION_ID: mine }, null, mine)).toBeNull();
});

test("an unreadable ancestor before the operation's boundary cannot vouch for it", () => {
  const cc = { CLAUDE_CODE_SESSION_ID: mine };
  expect(inheritedRunIdentity({ ...op, ...cc }, [proc({ ...op, ...cc }), null], undefined)).toBe("operation_unverified");
});

test("the CLI names an owned LobeHub topic and leaves an inherited Herdr tab alone", () => {
  const root = tempRoot();
  const bin = join(root, "bin");
  mkdirSync(bin);
  const state = join(root, "state.json");
  writeFileSync(state, JSON.stringify({ calls: [], topic: { id: topicId, title: "派发提示词", trigger: "task", createdAt: "2026-11-15T13:33:16.997Z", metadata: { runningOperation: { operationId } } } }));
  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bun\nimport { readFileSync, writeFileSync } from "node:fs";\nconst s = JSON.parse(readFileSync(${JSON.stringify(state)}, "utf8"));\nconst a = process.argv.slice(2); s.calls.push([${JSON.stringify(name)}, ...a]);\n${body}\nwriteFileSync(${JSON.stringify(state)}, JSON.stringify(s));\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake("lh", `if (a[1] === "view") console.log(JSON.stringify({ topic: s.topic })); else if (a[1] === "edit") s.topic.title = a[4];`);
  fake("herdr", `console.log("{}");`);
  const env: Record<string, string> = { PATH: `${bin}:${process.env.PATH}`, HOME: root, ...ownerEnv, HERDR_PANE_ID: "inherited:p1" };
  const run = Bun.spawnSync(["bun", script, "--type", "OPT", "--topic", "会话命名迁入 conduct"], { env, stdout: "pipe", stderr: "pipe" });
  const output = JSON.parse(run.stdout.toString());
  expect(run.exitCode).toBe(0);
  expect(output).toMatchObject({ ok: true, named: true, label: "1115｜OPT｜会话命名迁入 conduct" });
  const calls: string[][] = JSON.parse(readFileSync(state, "utf8")).calls;
  expect(calls.some((call) => call[0] === "herdr")).toBe(false);
  expect(JSON.parse(readFileSync(state, "utf8")).topic.title).toBe("1115｜OPT｜会话命名迁入 conduct");
});

// ---- Codex thread ----

const threadId = "01a12306-d08c-7571-ae96-702784b75a5f";
const createdAt = Date.parse("2026-10-09T19:36:51Z") / 1000;

function daemon(options: { wrongId?: boolean; missingDate?: boolean; ignoredWrite?: boolean; name?: string } = {}) {
  const calls: { method: string; params: any }[] = [];
  let name = options.name ?? "旧标题";
  return {
    calls,
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "thread/name/set") { if (!options.ignoredWrite) name = params.name; return {}; }
      if (method === "thread/read") return { thread: { id: options.wrongId ? "another-thread" : threadId, createdAt: options.missingDate ? null : createdAt, updatedAt: createdAt + 86400, name } };
      throw new Error(`Unexpected method ${method}`);
    },
  };
}
const writes = (d: ReturnType<typeof daemon>) => d.calls.filter((call) => call.method === "thread/name/set");

test("names only the explicit current thread and verifies it", async () => {
  const d = daemon();
  expect((await nameCodexThread(d.request, threadId, "FIX", "会话归属", false)).status).toBe("named");
  expect(writes(d)).toEqual([{ method: "thread/name/set", params: { threadId, name: "1010｜FIX｜会话归属" } }]);
});

for (const options of [{ wrongId: true }, { missingDate: true }]) {
  test(`does not write with invalid thread metadata ${JSON.stringify(options)}`, async () => {
    const d = daemon(options);
    await expect(nameCodexThread(d.request, threadId, "FIX", "会话归属", false)).rejects.toThrow();
    expect(writes(d)).toHaveLength(0);
  });
}

test("a thread title that does not read back is reported without replaying the write", async () => {
  const d = daemon({ ignoredWrite: true });
  await expect(nameCodexThread(d.request, threadId, "FIX", "会话归属", false)).rejects.toThrow("read-back");
  expect(writes(d)).toHaveLength(1);
});

// ---- Claude Code ----

test("Claude Code sessions are dated by the earliest transcript record", () => {
  const root = tempRoot();
  const id = "2a71e054-96e5-4892-a1ee-997489b2beb6";
  mkdirSync(join(root, ".claude", "projects", "-work"), { recursive: true });
  writeFileSync(join(root, ".claude", "projects", "-work", `${id}.jsonl`), [
    JSON.stringify({ type: "session-owner", sessionId: id }),
    JSON.stringify({ type: "queue-operation", timestamp: "2026-11-15T16:30:00.000Z" }),
    JSON.stringify({ type: "user", timestamp: "2026-11-15T16:00:00.000Z" }),
  ].join("\n"));
  expect(claudeSessionCreatedAt({ CLAUDE_CODE_SESSION_ID: id }, root)).toBe(Date.parse("2026-11-15T16:00:00.000Z"));
  expect(claudeSessionCreatedAt({ CLAUDE_CODE_SESSION_ID: "00000000-0000-0000-0000-000000000000" }, root)).toBeNull();
});
