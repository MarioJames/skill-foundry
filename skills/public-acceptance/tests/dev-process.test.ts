import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ancestry, belongs, identity, inspect, matchingPanes, type ProcessInfo } from "../scripts/lib/dev-process";

const runner = resolve(import.meta.dir, "../scripts/dev-run.ts");
const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
function scratch() { const path = mkdtempSync(join(tmpdir(), "public-dev-")); roots.push(path); return path; }
async function waitFor<T>(read: () => T | null, label: string): Promise<T> {
  for (let i = 0; i < 80; i++) { const result = read(); if (result !== null) return result; await Bun.sleep(50); }
  throw new Error(`timeout: ${label}`);
}
function state(path: string) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
async function server(project: string) {
  const file = join(project, `server-${children.length}.ts`);
  const ready = join(project, `ready-${children.length}.json`);
  writeFileSync(file, `const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture-app")});
await Bun.write(${JSON.stringify(ready)}, JSON.stringify({pid: process.pid, port: server.port}));
console.log("service ready without a URL");`);
  const log = join(project, `output-${children.length}.log`);
  const fd = openSync(log, "a");
  const child = Bun.spawn([process.execPath, file], { cwd: project, stdout: fd, stderr: fd });
  closeSync(fd); children.push(child);
  const info = await waitFor(() => state(ready), "server ready");
  return { child, info, log };
}
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill("SIGTERM"); await child.exited; }
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("project and pane ownership", () => {
  test("path boundaries exclude similarly named projects", () => {
    expect(belongs("/work/app-copy", "/work/app")).toBe(false);
    expect(belongs("/work/app/packages/web", "/work/app")).toBe(true);
    expect(belongs(null, "/work/app")).toBe(false);
  });
  test("pane matching uses actual ancestry or TTY, never a shared ancestor", () => {
    const table = new Map<number, ProcessInfo>([
      [20, { pid: 20, parentPid: 2, tty: "pts/1", token: "shell" }],
      [30, { pid: 30, parentPid: 20, tty: "pts/1", token: "launcher" }],
      [40, { pid: 40, parentPid: 30, tty: "pts/1", token: "server" }],
      [50, { pid: 50, parentPid: 2, tty: "pts/2", token: "other shell" }],
      [60, { pid: 60, parentPid: 1, tty: "pts/1", token: "reparented" }],
    ]);
    const panes = [
      { pane_id: "dev", tab_id: "server", shell_pid: 20, foreground_pids: [30] },
      { pane_id: "other", tab_id: "agent", shell_pid: 50, foreground_pids: [] },
    ];
    expect(ancestry(40, table)).toEqual([40, 30, 20, 2]);
    expect(matchingPanes(40, table, panes).map(p => p.pane_id)).toEqual(["dev"]);
    expect(matchingPanes(60, table, panes).map(p => p.pane_id)).toEqual(["dev"]);
  });
});

test("missing scanner is an explicit error, not an empty discovery result", () => {
  const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../scripts/dev.ts"), "inspect", "--project", scratch()], {
    env: { ...process.env, PATH: "/nonexistent-public-dev-test-bin" }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  const output = JSON.parse(result.stdout.toString());
  expect(output.ok).toBe(false);
  expect(output.error).toContain("strayd unavailable");
});

describe("real listener discovery", () => {
  test("finds live random port and file log without a printed URL; excludes sibling project", async () => {
    const root = scratch(), project = join(root, "app"), other = join(root, "app-copy");
    mkdirSync(project); mkdirSync(other);
    const target = await server(project); await server(other);
    const found = inspect(project);
    expect(found.status).toBe("single");
    expect(found.candidates[0].pid).toBe(target.info.pid);
    expect(found.candidates[0].ports).toContain(target.info.port);
    expect(found.candidates[0].output[0]).toEqual({ fd: 1, kind: "file", path: target.log });
    expect(found.http_verified).toBe(false);
    expect(await (await fetch(`http://127.0.0.1:${target.info.port}`)).text()).toBe("fixture-app");
  });
  test("reports multiple instances instead of choosing an arbitrary port", async () => {
    const project = scratch();
    const a = await server(project), b = await server(project);
    const found = inspect(project);
    expect(found.status).toBe("multiple");
    expect(found.candidates.map(c => c.pid).sort()).toEqual([a.info.pid, b.info.pid].sort());
    expect(inspect(project, a.info.pid).candidates.map(c => c.pid)).toEqual([a.info.pid]);
    a.child.kill(); await a.child.exited;
    expect(() => inspect(project, a.info.pid)).toThrow("no longer running");
  });
});

describe("foreground runner", () => {
  test("tees output and exposes child port through runner ancestry; stops task-owned children", async () => {
    const project = scratch(), stateDir = join(project, "state");
    const ready = join(project, "ready.json");
    const file = join(project, "app.ts");
    writeFileSync(file, `const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("runner-app")});
console.log("dev output visible"); console.error("dev error visible");
await Bun.write(${JSON.stringify(ready)}, JSON.stringify({pid: process.pid, port: server.port}));`);
    const child = Bun.spawn([process.execPath, runner, "--project", project, "--state-dir", stateDir, "--", "bash", "-c", `${process.execPath} ${file} & wait`], { stdout: "pipe", stderr: "pipe" });
    children.push(child);
    const info = await waitFor(() => state(ready), "runner server");
    const record = await waitFor(() => state(join(stateDir, "dev-process.json")), "runner state");
    expect(record.runner_pid).toBe(child.pid);
    expect(record.runner_identity).toBe(identity(child.pid));
    expect(inspect(project, child.pid).candidates[0].ports).toContain(info.port);
    await waitFor(() => readFileSync(record.log_path, "utf8").includes("dev error visible") ? true : null, "tee log");
    const duplicate = Bun.spawn([process.execPath, runner, "--project", project, "--state-dir", stateDir, "--", "false"], { stdout: "pipe", stderr: "pipe" });
    expect(await duplicate.exited).toBe(1);
    expect(state(join(stateDir, "dev-process.json")).runner_pid).toBe(child.pid);
    child.kill("SIGTERM"); await child.exited;
    expect(identity(info.pid)).toBe(null);
    expect(state(join(stateDir, "dev-process.json")).running).toBe(false);
    expect(await new Response(child.stdout).text()).toContain("dev output visible");
    expect(await new Response(child.stderr).text()).toContain("dev error visible");
  });
  test("propagates command failure and retains logs", async () => {
    const project = scratch(), stateDir = join(project, "state");
    const child = Bun.spawn([process.execPath, runner, "--project", project, "--state-dir", stateDir, "--", "bash", "-c", "echo startup-failed >&2; exit 7"], { stdout: "pipe", stderr: "pipe" });
    children.push(child);
    expect(await child.exited).toBe(7);
    expect(state(join(stateDir, "dev-process.json")).exit_code).toBe(7);
    expect(readFileSync(join(stateDir, "dev.log"), "utf8")).toContain("startup-failed");
  });
});
