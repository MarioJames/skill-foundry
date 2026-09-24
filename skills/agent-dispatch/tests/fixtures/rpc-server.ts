import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const scenario = process.argv[2];
const send = (x: any) => process.stdout.write(JSON.stringify(x) + "\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const m = JSON.parse(line);
  appendFileSync("requests.jsonl", line + "\n");
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "thread" }, model: scenario === "wrong-profile" ? "wrong" : m.params.model, reasoningEffort: m.params.config?.model_reasoning_effort ?? "medium", approvalPolicy: "never", sandbox: { type: "readOnly" } } });
  if (m.method === "turn/start") {
    if (scenario === "eof") process.exit(0);
    send({ method: "turn/completed", params: { threadId: "other", turn: { id: "turn", status: "completed", items: [] } } });
    if (scenario === "approval") {
      send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "turn" } });
      return;
    }
    if (["cancel", "timeout"].includes(scenario)) { send({ id: m.id, result: { turn: { id: "turn" } } }); return; }
    const item = { type: "agentMessage", id: "message", phase: "final_answer", text: JSON.stringify({ status: "completed", summary: "delivered", artifact_refs: ["report.md"] }) };
    const notification = { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: scenario === "failed" ? "failed" : "completed", items: [item] } } };
    const wire = JSON.stringify(notification) + "\n";
    // Completion before the turn/start response, split across chunks.
    process.stdout.write(wire.slice(0, 15));
    setTimeout(() => { process.stdout.write(wire.slice(15)); send({ id: m.id, result: { turn: { id: "turn" } } }); }, 5);
    process.stderr.write("x".repeat(90_000));
  }
  if (m.method === "turn/interrupt") send({ id: m.id, result: {} });
});
lines.on("close", () => process.exit(0));
