import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { taskBatch } from "../scripts/lib/task-input";
import { validateRoutingConfig } from "../scripts/lib/agent-engines";

const config = validateRoutingConfig(JSON.parse(readFileSync(new URL("../examples/agents.json", import.meta.url), "utf8")));
const input = () => JSON.parse(readFileSync(new URL("../examples/task.json", import.meta.url), "utf8"));
const state = (): any => ({ version: 1, batch_id: null, assessments: {}, decisions: [], classification_runs: [], attempts: [] });
test("native Herdr pane identity is an opaque reservation key", () => {
  const x = input(); x.owner.id = "w26:p6";
  const r = taskBatch(x, state(), config);
  expect(r.agents[0].pane_id).toBe("w26:p6");
  expect(r.batch.external_resources[0].id).toBe("w26:p6");
});
test("single-task caller cannot bypass Jev parallel selection", () => {
  const x = input(); x.parallel_evidence = "I think it is independent";
  expect(() => taskBatch(x, state(), config)).toThrow("cannot bypass");
});
test("a task revision is not replayed and an unaccepted dependency is not fabricated", () => {
  const x = input(), s = state(); s.attempts.push({ task: { id: x.id, revision: 1 } });
  expect(() => taskBatch(x, s, config)).toThrow("already has an attempt");
  x.depends_on = ["missing"];
  expect(() => taskBatch(x, state(), config)).toThrow("accepted current revision");
});
