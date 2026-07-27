#!/usr/bin/env bun
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
  detached: false, stdio: "ignore", env: process.env,
});
process.stdout.write(`${child.pid}\n`);
process.exit(0);
