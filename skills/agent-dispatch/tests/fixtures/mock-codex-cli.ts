import { createInterface } from "node:readline";

const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "agent_dispatch_catalog/0.156.1" } });
  if (message.method === "model/list") send({ id: message.id, result: { data: [{ model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "max" }] }], nextCursor: null } });
  if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread" }, model: message.params.model, reasoningEffort: message.params.config?.model_reasoning_effort, approvalPolicy: "never", sandbox: { type: "readOnly" } } });
  if (message.method === "turn/start") {
    const id = `turn-${message.id}`;
    send({ id: message.id, result: { turn: { id } } });
    const item = { type: "agentMessage", id: `message-${message.id}`, phase: "final_answer", text: JSON.stringify({ status: "completed", summary: "read-only mock delivery", artifact_refs: [] }) };
    send({ method: "turn/completed", params: { threadId: "thread", turn: { id, status: "completed", items: [item] } } });
  }
  if (message.method === "turn/interrupt") send({ id: message.id, result: {} });
}
