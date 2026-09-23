#!/usr/bin/env bun
import { inspect } from "./lib/dev-process";

const usage = `Usage: dev.ts inspect --project PATH [--root-pid PID]
Read-only socket/PID/project/pane discovery via strayd and native process metadata.
Returns candidates, not APP_URL; verify HTTP and project identity before reuse.
No matching listener does not prove that no dev process is starting.`;

if (Bun.argv.includes("--help")) {
  console.log(usage);
} else {
  try {
    const [mode, ...args] = Bun.argv.slice(2);
    if (mode !== "inspect") throw new Error(usage);
    let project: string | undefined;
    let rootPid: number | undefined;
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (!value) throw new Error(`missing value: ${flag}`);
      if (flag === "--project") project = value;
      else if (flag === "--root-pid" && /^\d+$/.test(value) && Number(value) > 1) rootPid = Number(value);
      else throw new Error(`invalid argument: ${flag}`);
    }
    if (!project) throw new Error("--project required");
    console.log(JSON.stringify({ ok: true, ...inspect(project, rootPid) }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
