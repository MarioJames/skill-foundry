import { appendFileSync } from "node:fs";

globalThis.fetch = (async (_url: unknown, options: RequestInit) => {
  const request = JSON.parse(String(options.body));
  const choice = Object.keys(request.questions.schedule.criteria).find((x) => x.startsWith("wave_"));
  appendFileSync(process.env.MOCK_JEV_COUNT_FILE!, `${choice}\n`);
  if (process.env.MOCK_JEV_FAIL === "1") throw new Error("simulated provider failure");
  return new Response(JSON.stringify({ model: "~typesafe/jev-latest", usage: { input_tokens: 1, output_tokens: 1 }, answers: { schedule: { type: "choice", choice, confidence: 0.95 } } }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;
