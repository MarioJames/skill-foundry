import { expect, test } from "bun:test";
import { codexThreadId, nameCodexSession, taskLabel } from "../scripts/lib/codex-session";

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

test("uses current thread even when SESSION identifies the parent tree", () => {
  expect(codexThreadId({ CODEX_THREAD_ID: threadId, CODEX_SESSION_ID: "parent-thread" })).toBe(threadId);
  expect(() => codexThreadId({ CODEX_SESSION_ID: threadId, HERDR_PANE_ID: "wrong" })).toThrow("CODEX_THREAD_ID");
});

test("label uses creation date in Shanghai, not host timezone or update date", () => {
  expect(taskLabel(createdAt, "FIX", "会话归属")).toBe("1010｜FIX｜会话归属");
  expect(() => taskLabel(createdAt, "BAD", "会话归属")).toThrow();
  expect(() => taskLabel(createdAt, "FIX", "两行\n标题")).toThrow();
});

test("names only the explicit current thread and verifies it", async () => {
  const d = daemon();
  const result = await nameCodexSession(d.request, threadId, "FIX", "会话归属", false);
  expect(result.changed).toBe(true);
  expect(d.calls).toEqual([
    { method: "thread/read", params: { threadId, includeTurns: false } },
    { method: "thread/name/set", params: { threadId, name: "1010｜FIX｜会话归属" } },
    { method: "thread/read", params: { threadId, includeTurns: false } },
  ]);
});

for (const options of [{ wrongId: true }, { missingDate: true }]) {
  test(`does not write with invalid thread metadata ${JSON.stringify(options)}`, async () => {
    const d = daemon(options);
    await expect(nameCodexSession(d.request, threadId, "FIX", "会话归属", false)).rejects.toThrow();
    expect(d.calls.every(c => c.method === "thread/read")).toBe(true);
  });
}

test("dry-run and an already matching name do not write", async () => {
  for (const dryRun of [true, false]) {
    const d = daemon({ name: dryRun ? "old" : "1010｜FIX｜会话归属" });
    expect((await nameCodexSession(d.request, threadId, "FIX", "会话归属", dryRun)).changed).toBe(false);
    expect(d.calls).toHaveLength(1);
  }
});

test("failed verification is reported without replaying the write", async () => {
  const d = daemon({ ignoredWrite: true });
  await expect(nameCodexSession(d.request, threadId, "FIX", "会话归属", false)).rejects.toThrow("read-back");
  expect(d.calls.filter(c => c.method === "thread/name/set")).toHaveLength(1);
});
