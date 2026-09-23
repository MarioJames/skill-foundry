import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  observeAttempt,
  cleanupAttempt,
  transport,
} from "../scripts/lib/agent-runtime";
import { runAttempt } from "../scripts/lib/dispatch-state";
const attempt = (dir: string): any => ({
  id: "attempt",
  task: { id: "date", revision: 2 },
  phase: "running",
  slot: "held",
  writes_held: true,
  session_id: "session",
  binding: {
    task: { execution: { cwd: dir } },
    launch: { kind: "codex", argv: ["--model", "example"] },
  },
  lane: {
    pane_id: "owned",
    tab_id: "tab",
    workspace_id: "workspace",
    ownership: "created",
    cleanup_command: ["herdr", "tab", "close", "tab"],
  },
  effects: [
    {
      operation: "start_agent",
      state: "confirmed",
      evidence: { terminal_id: "terminal" },
    },
  ],
  result_path: join(dir, "result.json"),
});
const info = (session = "session", status = "idle") => ({
  result: {
    agent: {
      pane_id: "owned",
      tab_id: "tab",
      workspace_id: "workspace",
      agent: "codex",
      agent_status: status,
      terminal_id: "terminal",
      agent_session: { value: session },
    },
  },
});
async function isolated(work: (d: string) => Promise<void>) {
  const d = mkdtempSync(join(tmpdir(), "herdr-runtime-"));
  try {
    await work(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
test("idle is not completion; mismatched result or reused session retains reservation", async () =>
  isolated(async (d) => {
    const a = attempt(d);
    await observeAttempt(a, async () => info());
    expect(a.slot).toBe("held");
    const r = {
      attempt_id: "other",
      task_id: "date",
      task_revision: 2,
      status: "completed",
      summary: "done",
      artifact_refs: ["path"],
    };
    writeFileSync(a.result_path, JSON.stringify(r));
    await observeAttempt(a, async () => info());
    expect(a.slot).toBe("held");
    r.attempt_id = a.id;
    writeFileSync(a.result_path, JSON.stringify(r));
    await observeAttempt(a, async () => info("replaced"));
    expect(a.slot).toBe("held");
    await observeAttempt(a, async () => info());
    expect(a.slot).toBe("released");
    expect(a.writes_held).toBe(true);
    expect(a.phase).toBe("finished");
  }));
test("submission checks the owned idle session and never injects into busy work", async () =>
  isolated(async (d) => {
    const a = attempt(d);
    let calls = 0;
    await expect(
      transport("parent", "label", async () => {
        calls++;
        return info("session", "working");
      }).submit(a),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  }));
test("cleanup refuses caller, additional panes, unknown sessions and unresolved writes", async () =>
  isolated(async (d) => {
    const a = attempt(d);
    await expect(
      cleanupAttempt(a, "parent", async () => info()),
    ).rejects.toThrow();
    a.slot = "released";
    a.writes_held = false;
    await expect(
      cleanupAttempt(a, "owned", async () => info()),
    ).rejects.toThrow();
    let calls = 0;
    await expect(
      cleanupAttempt(a, "parent", async (argv) => {
        calls++;
        return argv[1] === "agent"
          ? info()
          : { result: { tab: { pane_count: 2 } } };
      }),
    ).rejects.toThrow();
    expect(calls).toBe(2);
    const ready = await cleanupAttempt(a, "parent", async (argv) =>
      argv[1] === "agent"
        ? info()
        : {
            result: {
              tab: { pane_count: 1 },
              panes: [
                { pane_id: "owned", tab_id: "tab", workspace_id: "workspace" },
              ],
            },
          },
    );
    expect(ready.command).toEqual(a.lane.cleanup_command);
  }));
test("revocation between create and start stops before the next side effect", async () =>
  isolated(async (d) => {
    const a = attempt(d);
    a.phase = "prepared";
    a.effects = [];
    let guard = 0,
      start = 0;
    await runAttempt(
      a,
      () => {},
      {
        create: async () => a.lane,
        start: async () => {
          start++;
          return {};
        },
        submit: async () => ({}),
      },
      () => {
        if (++guard === 2) throw Error("revoked");
      },
    );
    expect(start).toBe(0);
    expect(a.effects).toHaveLength(1);
    expect(a.slot).toBe("held");
    expect(a.resolution.outcome).toBe("authorization_changed");
  }));

test("generated Herdr names fit its 32-character native contract", async () =>
  isolated(async (d) => {
    const a = attempt(d);
    a.id = "01234567-89ab-cdef-0123-456789abcdef";
    await transport("parent", "label", async (argv) => {
      if (argv[2] === "start") {
        expect(argv[3]).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
        return {};
      }
      return info();
    }).start(a);
  }));

test("worker receives global goal and constraints from the frozen binding", async () =>
  isolated(async (d) => {
    const a = attempt(d);
    a.binding.goal = "Preserve UTC contract";
    a.binding.constraints = ["Never change the public format"];
    let prompt = "";
    await transport("parent", "label", async (argv) => {
      if (argv[2] === "get") return info();
      prompt = argv[4];
      return {};
    }).submit(a);
    expect(prompt).toContain("Preserve UTC contract");
    expect(prompt).toContain("Never change the public format");
  }));

test("observing an explicitly resolved attempt cannot resurrect an old completion", async () =>
  isolated(async (d) => {
    const a = attempt(d);
    a.phase = "cancelled";
    a.slot = "released";
    a.writes_held = false;
    a.resolution = {
      outcome: "cancelled_stopped",
      evidence: "owner stopped it",
    };
    writeFileSync(
      a.result_path,
      JSON.stringify({
        attempt_id: a.id,
        task_id: "date",
        task_revision: 2,
        status: "completed",
        summary: "old result",
        artifact_refs: ["path"],
      }),
    );
    await observeAttempt(a, async () => info());
    expect(a.phase).toBe("cancelled");
  }));

test("cleanup rejects moved pane even when original container still has one member", async () =>
  isolated(async (d) => {
    const a = attempt(d);
    a.slot = "released";
    a.writes_held = false;
    const moved = info();
    Object.assign(moved.result.agent, {
      tab_id: "different",
      workspace_id: "elsewhere",
    });
    await expect(
      cleanupAttempt(a, "parent", async (argv) =>
        argv[1] === "agent"
          ? moved
          : {
              result: {
                tab: { pane_count: 1 },
                panes: [
                  {
                    pane_id: "unrelated",
                    tab_id: "tab",
                    workspace_id: "workspace",
                  },
                ],
              },
            },
      ),
    ).rejects.toThrow();
  }));

test("cleanup confirmation also requires removal readback", async () =>
  isolated(async (d) => {
    const a = attempt(d);
    a.slot = "released";
    a.writes_held = false;
    const close = await cleanupAttempt(a, "parent", async (argv) =>
      argv[1] === "agent"
        ? info()
        : argv[1] === "pane"
          ? {
              result: {
                panes: [
                  {
                    pane_id: "owned",
                    tab_id: "tab",
                    workspace_id: "workspace",
                  },
                ],
              },
            }
          : { result: { tab: { pane_count: 1 }, tabs: [{ tab_id: "tab" }] } },
    );
    await expect(close.execute()).rejects.toThrow("Removal not verified");
  }));
