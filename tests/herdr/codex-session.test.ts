import { expect, test } from "bun:test";
import { codexThreadId } from "../../skills/herdr/scripts/lib/codex-session";

const threadId = "01a12306-d08c-7571-ae96-702784b75a5f";

test("binds the current thread even when SESSION identifies the parent tree", () => {
  expect(codexThreadId({ CODEX_THREAD_ID: threadId, CODEX_SESSION_ID: "parent-thread" })).toBe(threadId);
  expect(() => codexThreadId({ CODEX_SESSION_ID: threadId, HERDR_PANE_ID: "wrong" })).toThrow("CODEX_THREAD_ID");
});
