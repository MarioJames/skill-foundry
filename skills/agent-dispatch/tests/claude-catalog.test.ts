import { expect, test } from "bun:test";
import { claudeCatalog } from "../scripts/lib/claude-catalog";

const fixture = (reply: string) => [process.execPath, "-e", `
  import {createInterface} from "node:readline";
  const lines=createInterface({input:process.stdin});
  for await (const line of lines) {
    const request=JSON.parse(line);
    if(request.type!=="control_request" || request.request.subtype!=="initialize") process.exit(2);
    console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:"unrelated",response:{models:[{value:"wrong"}]}}}));
    ${reply}
  }
`];
test("Claude catalog correlates initialize and reaps its own process without submitting a turn", async () => {
  const models = [{ value: "future-model", resolvedModel: "provider-id", supportsEffort: true, supportedEffortLevels: ["high"] }];
  const result = await claudeCatalog({ command: fixture(`console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:request.request_id,response:{models:${JSON.stringify(models)}}}}));`), timeoutMs: 2000 });
  expect(result).toEqual(models);
});
test("Claude catalog refuses malformed/error responses and never exposes raw diagnostics", async () => {
  for (const reply of [
    'console.log("SECRET");',
    'console.log(JSON.stringify({type:"control_response",response:{subtype:"error",request_id:request.request_id,error:"SECRET"}}));',
    'console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:request.request_id,response:{models:[]}}}));',
  ]) {
    const error = await claudeCatalog({ command: fixture(reply), timeoutMs: 2000 }).catch((e) => e);
    expect(error.code).toBe("claude_catalog_unknown");
    expect(String(error)).not.toContain("SECRET");
  }
});
test("Claude catalog terminates an unresponsive child and handles a missing binary", async () => {
  const started = Date.now();
  const script = `process.stdin.on("data",()=>{}); setInterval(()=>{},1000);`;
  await expect(claudeCatalog({ command: [process.execPath, "-e", script], timeoutMs: 50 })).rejects.toMatchObject({ code: "claude_catalog_unknown" });
  expect(Date.now() - started).toBeLessThan(2000);
  await expect(claudeCatalog({ command: ["/nonexistent/claude"], timeoutMs: 1000 })).rejects.toMatchObject({ code: "claude_catalog_unknown" });
});
