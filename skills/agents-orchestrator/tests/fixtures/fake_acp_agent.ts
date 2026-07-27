#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

interface Options {
  scenario: string;
  counterFile?: string;
  promptFile?: string;
  initializeDelay: number;
  sessionDelay: number;
}

function parse(): Options {
  const value = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  return {
    scenario: value("--scenario") ?? "basic",
    counterFile: value("--counter-file"),
    promptFile: value("--prompt-file"),
    initializeDelay: Number(value("--initialize-delay") ?? 0),
    sessionDelay: Number(value("--session-delay") ?? 0),
  };
}

function runtimeAction(type: string, payload: unknown): Record<string, any> {
  const skill = process.env.AGENTS_ORCHESTRATOR_SKILL_DIR ?? process.env.AGENT_SWARM_SKILL_DIR;
  if (!skill) throw new Error("missing Runtime skill directory");
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(skill, "scripts", "agent_orchestrator.ts"), "action", "--type", type, "--stdin"],
    stdin: Buffer.from(JSON.stringify(payload)), stdout: "pipe", stderr: "pipe", timeout: 15_000, env: process.env,
  });
  if (result.exitCode !== 0) throw new Error("Runtime action failed");
  return JSON.parse(result.stdout.toString());
}

class FakeAgent {
  private cancelled = new Map<string, () => void>();
  constructor(private readonly options: Options) {}

  async initialize(): Promise<acp.InitializeResponse> {
    await Bun.sleep(this.options.initializeDelay * 1000);
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: this.options.scenario === "history",
        auth: {},
        sessionCapabilities: { close: {} },
      },
      agentInfo: { name: "fake-acp", title: "Fake ACP", version: "1.0.0" },
    };
  }

  async newSession(): Promise<acp.NewSessionResponse> {
    await Bun.sleep(this.options.sessionDelay * 1000);
    return { sessionId: `fake-session-${process.env.AGENT_SWARM_ATTEMPT_ID ?? "standalone"}-${process.pid}` };
  }

  private promptText(params: acp.PromptRequest): string {
    return params.prompt.map((item) => item.type === "text" ? item.text : "").filter(Boolean).join("\n");
  }

  async prompt(params: acp.PromptRequest, client: acp.AgentContext): Promise<acp.PromptResponse> {
    const text = this.promptText(params);
    if (this.options.promptFile) writeFileSync(this.options.promptFile, text, "utf8");
    if (this.options.scenario === "hold") {
      await new Promise<void>((resolveCancelled) => this.cancelled.set(params.sessionId, resolveCancelled));
      return { stopReason: "cancelled" };
    }
    if (this.options.scenario === "crash") process.exit(23);
    if (this.options.scenario === "raw-error") throw new Error("AGENT_RAW_SECRET_SENTINEL");
    if (this.options.scenario === "split") { this.finishSplit(text); return { stopReason: "end_turn" }; }
    if (this.options.scenario === "finish") { await Bun.sleep(250); this.finishDirect(); return { stopReason: "end_turn" }; }
    if (this.options.scenario === "permission") {
      const response = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "fake-call", title: "write", kind: "edit",
          locations: [{ path: join(process.cwd(), "inside.txt") }],
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "deny-once", name: "Deny once", kind: "reject_once" },
        ],
      });
      if (response.outcome.outcome !== "selected" || response.outcome.optionId !== "allow-once") throw new Error("permission was denied");
    }
    return { stopReason: "end_turn" };
  }

  async loadSession(params: acp.LoadSessionRequest, client: acp.AgentContext): Promise<acp.LoadSessionResponse> {
    if (this.options.scenario !== "history") throw acp.RequestError.methodNotFound("session/load");
    if (params.sessionId === "missing-session") throw acp.RequestError.resourceNotFound(params.sessionId);
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "remembered user message" } },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "remembered agent response" } },
    });
    return {};
  }

  cancel(sessionId: string): void { this.cancelled.get(sessionId)?.(); this.cancelled.delete(sessionId); }

  private estimate(strategy: string, complexity: string, reason: string): void {
    runtimeAction("submit_estimate", {
      revision: false, strategy, resolved_intent: "implement", complexity,
      concerns: [], unknowns: [], estimated_files: [], reason,
    });
  }

  private finish(summary: string, integration: unknown = null): void {
    runtimeAction("finish", {
      status: "done", retryable: false, summary, changed_files: [], artifacts: [],
      validation: null, review: null, integration_check: integration, caveats: [],
    });
  }

  private finishDirect(): void { this.estimate("direct", "low", "deterministic fake task"); this.finish("fake ACP child finished"); }

  private finishSplit(prompt: string): void {
    const parent = prompt.includes("\nchild goal\n");
    this.estimate(parent ? "split" : "direct", parent ? "medium" : "low", "deterministic fake split");
    let integration: unknown = null;
    if (parent) {
      const created = runtimeAction("create_tasks", { tasks: [
        { key: "leaf-a", goal: "leaf-a", intent_hint: "implement", output_contract: "finish leaf a" },
        { key: "leaf-b", goal: "leaf-b", intent_hint: "implement", output_contract: "finish leaf b" },
      ] });
      const waited = runtimeAction("wait", {
        task_ids: created.tasks.map((item: Record<string, any>) => item.task_id), condition: "all_done", listen_seconds: 15,
      });
      if (!waited.complete) throw new Error("fake split children did not finish");
      integration = { status: "passed", summary: "fake leaves integrated" };
    }
    this.finish("fake split task finished", integration);
  }
}

const options = parse();
if (options.counterFile) {
  const count = existsSync(options.counterFile) ? Number(readFileSync(options.counterFile, "utf8")) : 0;
  writeFileSync(options.counterFile, String(count + 1));
}
const fake = new FakeAgent(options);
const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
acp.agent({ name: "fake-acp" })
  .onRequest(acp.methods.agent.initialize, () => fake.initialize())
  .onRequest(acp.methods.agent.session.new, () => fake.newSession())
  .onRequest(acp.methods.agent.session.prompt, ({ params, client }) => fake.prompt(params, client))
  .onRequest(acp.methods.agent.session.load, ({ params, client }) => fake.loadSession(params, client))
  .onRequest(acp.methods.agent.session.close, () => ({}))
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => { fake.cancel(params.sessionId); })
  .connect(stream);
