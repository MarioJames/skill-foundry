import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "./cli";
import {
  probeProfile,
  executionProfile,
  type RoutingConfig,
} from "./agent-engines";
import { readJson, type Transport } from "./dispatch-state";
import {
  fields,
  object,
  strings,
  textValue,
  type Attempt,
  type Runtime,
} from "./scheduling";
export type Runner = (argv: string[]) => Promise<any>;
type TextReader = (pane: string) => Promise<string>;
const readTerminal: TextReader = (pane) => new Promise((resolve, reject) => {
  execFile("herdr", ["agent", "read", pane, "--source", "visible"], { timeout: 5000, maxBuffer: 128_000 }, (error, stdout) => error ? reject(new CliError("terminal_read_failed", "Cannot verify native composer")) : resolve(stdout));
});
export async function waitForCodexComposer(pane: string, read: TextReader = readTerminal, budget = 30_000) {
  const deadline = Date.now() + budget;
  do {
    const text = await read(pane);
    if (/^\s*›\s/mu.test(text) && !/model:\s+loading|Trust this folder\?/iu.test(text)) return;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);
  throw new CliError("composer_unconfirmed", "Codex composer not ready; inspect the owned pane, do not submit blindly");
}
export const command: Runner = (argv) =>
  new Promise((ok, no) => {
    execFile(
      argv[0],
      argv.slice(1),
      { timeout: 100_000, maxBuffer: 1_000_000 },
      (error, stdout) => {
        if (error) {
          let code = "command_unconfirmed";
          try {
            const raw = JSON.parse(stdout);
            if (
              typeof raw?.error?.code === "string" &&
              /^[a-z0-9_]{1,80}$/.test(raw.error.code)
            )
              code = raw.error.code;
          } catch {}
          no(
            new CliError(
              code,
              "Command did not return a verified response; inspect the existing resource",
            ),
          );
          return;
        }
        try {
          const data = JSON.parse(stdout);
          if (data?.error || data?.ok === false) throw Error();
          ok(data);
        } catch {
          no(
            new CliError(
              "command_unconfirmed",
              "Command response was not a confirmed JSON result",
            ),
          );
        }
      },
    );
  });
export async function waitForNativeSession(pane: string, original: any, expected: string | undefined, run: Runner = command, budget = 30_000): Promise<string> {
  const deadline = Date.now() + budget;
  do {
    const current = (await run(["herdr", "agent", "get", pane]))?.result?.agent;
    if (!original?.terminal_id || current?.terminal_id !== original.terminal_id || current?.pane_id !== pane || current?.agent !== original.agent || (expected && current?.agent_session?.value !== expected))
      throw new CliError("submit_unknown", "Native session identity changed after submission");
    if (current?.agent_session?.value) return current.agent_session.value;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);
  throw new CliError("submit_unknown", "Native session identity not available after submission; inspect existing work, do not replay");
}
export async function observeRuntime(
  config: RoutingConfig,
  run: Runner = command,
): Promise<Runtime> {
  const entries = await Promise.all(
    (["ordinary", "moderate", "complex"] as const).map(async (k) => [
      k,
      await probeProfile(config, executionProfile(config, k)),
    ]),
  );
  const data = await run(["herdr", "agent", "list"]),
    agents = data?.result?.agents;
  if (!Array.isArray(agents))
    throw new CliError(
      "runtime_unknown",
      "Cannot establish live Agent inventory",
    );
  return {
    observed_at: new Date().toISOString(),
    agents: agents.map((a) => {
      if (typeof a.pane_id !== "string" || typeof a.agent !== "string")
        throw new CliError("runtime_unknown", "Malformed Agent inventory");
      return {
        pane_id: a.pane_id,
        adapter: a.agent,
        engine_id:
          Object.keys(config.engines).find(
            (id) => config.engines[id].adapter === a.agent,
          ) ?? null,
        state: a.agent_status ?? "unknown",
        session_id: a.agent_session?.value,
        cwd: a.cwd,
      };
    }),
    probes: Object.fromEntries(entries) as Runtime["probes"],
  };
}
export function taskPrompt(a: Attempt) {
  return `You are delegated task ${a.task.id}, revision ${a.task.revision}, attempt ${a.id}. The parent owns integration, Git commits, dependency installation and shared configuration. Work only within declared ownership and authorization. Do not start other agents or change models. Report missing facts or boundary changes instead of expanding scope.\nYour created lane is ${JSON.stringify(a.lane)}; the parent owns its initial title and cleanup. Preserve existing data.\nOverall goal: ${a.binding.goal}\nGlobal constraints: ${JSON.stringify(a.binding.constraints)}\nTask contract:\n${JSON.stringify(a.binding.task, null, 2)}\nAccepted upstream artifacts:\n${JSON.stringify(a.binding.dependencies, null, 2)}\nWhen finished, write one JSON result to ${a.result_path} using an atomic file replacement. It must contain exactly {"attempt_id":"${a.id}","task_id":"${a.task.id}","task_revision":${a.task.revision},"status":"completed" or "failed","summary":"evidence and validation","artifact_refs":["delivered paths or commits"]}. Report only artifacts actually delivered. Completion is not parent acceptance. Do not modify the scheduler state or other attempts' results. Finish your turn after writing the result.`;
}
export function transport(
  callerPane: string,
  label: string,
  run: Runner = command,
  read: TextReader = readTerminal,
): Transport {
  return {
    async create(a) {
      mkdirSync(dirname(a.result_path), { recursive: true, mode: 0o700 });
      const r = await run([
        "bun",
        fileURLToPath(new URL("../../../herdr/scripts/route-lane.ts", import.meta.url)),
        "--type",
        "coding-agent",
        "--scope",
        "independent",
        "--cwd",
        a.binding.task.execution.cwd,
        "--caller-pane",
        callerPane,
        "--label",
        label,
      ]);
      const lane = {
        ...r.result,
        cleanup_command: r.lane?.cleanup_command,
        ownership: "created" as const,
      };
      if (
        !lane.pane_id ||
        !lane.tab_id ||
        !lane.workspace_id ||
        lane.pane_id === callerPane ||
        !Array.isArray(lane.cleanup_command)
      )
        throw new CliError("lane_unknown", "No verified owned lane returned");
      return lane;
    },
    async start(a) {
      const r = await run([
        "herdr",
        "agent",
        "start",
        `herdr-${a.id.replaceAll("-", "").slice(0, 24)}`,
        "--kind",
        a.binding.launch.kind,
        "--pane",
        a.lane!.pane_id,
        "--timeout",
        "90000",
        "--",
        ...a.binding.launch.argv,
      ]);
      if (a.binding.launch.kind === "codex") await waitForCodexComposer(a.lane!.pane_id, read);
      const agent = (await run(["herdr", "agent", "get", a.lane!.pane_id]))
        ?.result?.agent;
      if (
        agent?.pane_id !== a.lane!.pane_id ||
        agent.agent !== a.binding.launch.kind ||
        agent.agent_status !== "idle"
      )
        throw new CliError(
          "start_unknown",
          "Started Agent not verified idle in the owned pane",
        );
      return {
        session_id: agent.agent_session?.value,
        terminal_id: agent.terminal_id,
        requested: a.binding.profile,
        model_evidence: { mode: "launch_only", readback: null },
        reasoning_evidence: { mode: "launch_only", readback: null },
        start: r,
      };
    },
    async submit(a) {
      const agent = (await run(["herdr", "agent", "get", a.lane!.pane_id]))
        ?.result?.agent;
      const original = a.effects.find((e) => e.operation === "start_agent" && e.state === "confirmed")?.evidence as any;
      if (
        agent?.agent_status !== "idle" ||
        agent.pane_id !== a.lane!.pane_id ||
        !original?.terminal_id || agent.terminal_id !== original.terminal_id ||
        agent.agent !== a.binding.launch.kind ||
        (a.session_id && agent.agent_session?.value !== a.session_id)
      )
        throw new CliError(
          "submit_unknown",
          "Owned Agent is not the verified idle session",
        );
      const reply = await run([
        "herdr",
        "agent",
        "prompt",
        a.lane!.pane_id,
        taskPrompt(a),
        "--wait", "--until", "working", "--timeout", "15000",
      ]);
      // A native session can be reported only after the first user message starts.
      a.session_id = await waitForNativeSession(a.lane!.pane_id, agent, a.session_id, run);
      return reply;
    },
  };
}
function sameSession(a: Attempt, agent: any) {
  const started = a.effects.find(
    (e) => e.operation === "start_agent" && e.state === "confirmed",
  )?.evidence as any;
  return (
    agent?.pane_id === a.lane?.pane_id &&
    agent.agent === a.binding.launch.kind &&
    !!a.session_id &&
    agent.agent_session?.value === a.session_id &&
    (!started?.terminal_id || agent.terminal_id === started.terminal_id)
  );
}
export async function observeAttempt(a: Attempt, run: Runner = command) {
  if (a.slot !== "held") return;
  if (a.backend === "rpc") {
    try {
      const r = readJson(`${a.result_path}.rpc.json`, 128_000);
      if (r.attempt_id !== a.id || r.task_id !== a.task.id || r.task_revision !== a.task.revision || r.backend !== "rpc" || r.phase !== "terminal" || r.cleanup !== "stopped" || !["completed", "failed", "needs_owner", "cancelled", "unknown"].includes(r.outcome) || JSON.stringify(r.requested_profile) !== JSON.stringify(a.binding.profile)) throw Error();
      textValue(r.summary, "summary"); strings(r.artifact_refs, "artifact_refs");
      a.observed = r; a.cleanup = { state: "confirmed", backend: "rpc", stopped: true };
      a.slot = "released";
      a.phase = r.outcome === "completed" ? "finished" : r.outcome === "cancelled" ? "cancelled" : "failed";
      // Text-only research/probe delivery is still addressable evidence: retain the runner envelope.
      a.result = { attempt_id: a.id, task_id: a.task.id, task_revision: a.task.revision, status: r.outcome === "completed" ? "completed" : "failed", summary: r.summary, artifact_refs: r.artifact_refs.length ? r.artifact_refs : [`${a.result_path}.rpc.json`] };
      delete a.observation_error;
    } catch { a.observation_error = "RPC result/cleanup unconfirmed; reservation retained; do not replay"; }
    return;
  }
  if (!a.lane) {
    a.observation_error =
      "No known lane; owner must reconcile create intent without retry";
    return;
  }
  try {
    const agent = (await run(["herdr", "agent", "get", a.lane.pane_id]))?.result
      ?.agent;
    a.observed = { at: new Date().toISOString(), agent };
    if (!sameSession(a, agent)) {
      a.observation_error =
        "Session identity unavailable or changed; owner reconciliation required";
      return;
    }
    if (!["idle", "done"].includes(agent.agent_status)) {
      a.observation_error = "Agent is not finished";
      return;
    }
    if (!existsSync(a.result_path)) {
      a.observation_error = "No matching result; idle alone is not completion";
      return;
    }
    const r = object(readJson(a.result_path, 64_000), "attempt result");
    fields(r, [
      "attempt_id",
      "task_id",
      "task_revision",
      "status",
      "summary",
      "artifact_refs",
    ]);
    textValue(r.summary, "summary");
    strings(r.artifact_refs, "artifact_refs");
    if (
      r.attempt_id !== a.id ||
      r.task_id !== a.task.id ||
      r.task_revision !== a.task.revision ||
      !["completed", "failed"].includes(r.status)
    )
      throw Error();
    a.result = r as Attempt["result"];
    a.phase = r.status === "completed" ? "finished" : "failed";
    a.slot = "released";
    delete a.observation_error;
    // Even a failed worker may have written data. Retain ownership until acceptance or owner reconciliation.
  } catch {
    a.observation_error =
      "Observation or result is unverified; reservation retained";
  }
}
export async function cleanupAttempt(
  a: Attempt,
  callerPane: string,
  run: Runner = command,
) {
  if (
    !a.lane ||
    a.lane.ownership !== "created" ||
    a.lane.pane_id === callerPane ||
    a.slot === "held" ||
    a.writes_held
  )
    throw new CliError(
      "cleanup_blocked",
      "Only resolved, task-owned lanes can be closed",
    );
  const agent = (await run(["herdr", "agent", "get", a.lane.pane_id]))?.result
    ?.agent;
  if (
    !sameSession(a, agent) ||
    agent.tab_id !== a.lane.tab_id ||
    agent.workspace_id !== a.lane.workspace_id ||
    !["idle", "done"].includes(agent.agent_status)
  )
    throw new CliError(
      "cleanup_blocked",
      "Lane identity or idle state cannot be verified",
    );
  const cmd = a.lane.cleanup_command;
  const target =
    cmd[1] === "workspace"
      ? a.lane.workspace_id
      : cmd[1] === "tab"
        ? a.lane.tab_id
        : null;
  if (
    cmd.length !== 4 ||
    cmd[0] !== "herdr" ||
    cmd[2] !== "close" ||
    !target ||
    cmd[3] !== target
  )
    throw new CliError("cleanup_blocked", "Cleanup command not an owned scope");
  const info = (await run(["herdr", cmd[1], "get", target]))?.result?.[cmd[1]];
  if (
    info?.pane_count !== 1 ||
    (cmd[1] === "workspace" && info.tab_count !== 1)
  )
    throw new CliError(
      "cleanup_blocked",
      "Lane contains additional resources; owner must inspect",
    );
  const panes = (
    await run(["herdr", "pane", "list", "--workspace", a.lane.workspace_id])
  )?.result?.panes;
  if (!Array.isArray(panes))
    throw new CliError(
      "cleanup_blocked",
      "Cannot verify current lane membership",
    );
  const members =
    cmd[1] === "workspace"
      ? panes
      : panes.filter((p: any) => p.tab_id === a.lane!.tab_id);
  if (
    members.length !== 1 ||
    members[0].pane_id !== a.lane.pane_id ||
    members[0].workspace_id !== a.lane.workspace_id ||
    members[0].tab_id !== a.lane.tab_id
  )
    throw new CliError("cleanup_blocked", "Container membership changed");
  a.cleanup = { state: "intent", at: new Date().toISOString(), command: cmd };
  return {
    command: cmd,
    execute: async () => {
      const reply = await run(cmd);
      const list = await run([
        "herdr",
        cmd[1],
        "list",
        ...(cmd[1] === "tab" ? ["--workspace", a.lane!.workspace_id] : []),
      ]);
      const remaining =
        list?.result?.[cmd[1] === "workspace" ? "workspaces" : "tabs"];
      if (
        !Array.isArray(remaining) ||
        remaining.some((r: any) => r[`${cmd[1]}_id`] === target)
      )
        throw new CliError("cleanup_unknown", "Removal not verified");
      return { reply, removal_verified: true };
    },
  };
}
