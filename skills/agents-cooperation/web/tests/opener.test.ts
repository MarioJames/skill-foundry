import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeSyntheticPackage } from "./cli-fixture.ts";

function processEvidence(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], group: Number(fields[2]), starttime: fields[19] };
  } catch { return null; }
}
const alive = (pid: number, starttime: string) => { const current = processEvidence(pid); return current?.starttime === starttime && current.state !== "Z"; };
async function until(condition: () => boolean, milliseconds = 3000) {
  const deadline = Date.now() + milliseconds;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  expect(condition()).toBe(true);
}
async function bounded<T>(promise: Promise<T>, milliseconds = 2500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("process did not finish within the bounded wait")), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

async function fixture(mode: "success" | "failure" | "hold", noOpen = false) {
  const root = mkdtempSync(join(tmpdir(), "config-web-opener-"));
  const source = resolve(import.meta.dir, "../.."), skill = join(root, "skill"), web = join(skill, "web");
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
  const record = join(root, "opener.json"), signals = join(root, "signals.json");
  let output = "", errors = "";
  let readers: Promise<void>[] = [];
  const observed = () => existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) as { pid: number; starttime: string; group: number; argv: string[] } : null;
  const close = async () => {
    if (child?.exitCode === null) { child.kill("SIGTERM"); try { await bounded(child.exited); } catch { child.kill("SIGKILL"); await bounded(child.exited); } }
    // The application must leave opener processes alone. Only this test owns
    // these stubs and reclaims them by their exact PID and starttime evidence.
    const stub = observed();
    if (stub && alive(stub.pid, stub.starttime)) {
      process.kill(stub.pid, "SIGTERM");
      try { await until(() => !alive(stub.pid, stub.starttime)); }
      catch { if (alive(stub.pid, stub.starttime)) process.kill(stub.pid, "SIGKILL"); await until(() => !alive(stub.pid, stub.starttime)); }
    }
    if (child) await bounded(Promise.all(readers));
    if (stub) expect(alive(stub.pid, stub.starttime)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  };
  try {
    cpSync(join(source, "scripts"), join(skill, "scripts"), { recursive: true });
    cpSync(join(source, "assets"), join(skill, "assets"), { recursive: true });
    mkdirSync(web);
    for (const file of ["launch.ts", "server.ts", "package.json"]) cpSync(join(source, "web", file), join(web, file));
    cpSync(join(source, "web/lib"), join(web, "lib"), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(web, "package.json"), "utf8"));
    for (const name of Object.keys(manifest.dependencies)) writeSyntheticPackage(join(web, "node_modules"), name);
    writeFileSync(join(web, "index.html"), '<!doctype html><script type="module" src="./app.ts"></script><div>CLI fixture</div>');
    writeFileSync(join(web, "app.ts"), 'document.title="opener fixture";');
    const bin = join(root, "bin"); mkdirSync(bin);
    // Exclusive PATH: no missing stub can ever fall through to the user's opener.
    const stub = `#!${process.execPath}\nimport {readFileSync,writeFileSync,renameSync} from 'node:fs';const text=readFileSync('/proc/self/stat','utf8');const fields=text.slice(text.lastIndexOf(')')+2).split(' ');writeFileSync(${JSON.stringify(record + ".tmp")},JSON.stringify({pid:process.pid,argv:process.argv.slice(2),group:Number(fields[2]),starttime:fields[19]}));renameSync(${JSON.stringify(record + ".tmp")},${JSON.stringify(record)});${mode === "hold" ? `for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{writeFileSync(${JSON.stringify(signals)},JSON.stringify({signal}));process.exit(0);});setInterval(()=>{},1000);` : `process.exit(${mode === "success" ? 0 : 7});`}\n`;
    for (const name of ["xdg-open", "open"]) writeFileSync(join(bin, name), stub, { mode: 0o700 });
    const env = { ...process.env, PATH: bin, HOME: join(root, "home"), AGENTS_COOPERATION_CONFIG: join(root, "config.json"), AGENTS_COOPERATION_STATE: join(root, "state.sqlite") };
    child = Bun.spawn([process.execPath, join(skill, "scripts/agents-config.ts"), "web", "--port", "0", ...(noOpen ? ["--no-open"] : [])], { env, detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const read = async (stream: ReadableStream<Uint8Array>, append: (chunk: string) => void) => { for await (const bytes of stream) append(new TextDecoder().decode(bytes)); };
    readers = [read(child.stdout, chunk => { output += chunk; }), read(child.stderr, chunk => { errors += chunk; })];
    await until(() => /http:\/\/127\.0\.0\.1:\d+\//.test(output) || child!.exitCode !== null);
    const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0]; expect(url).toBeDefined();
    expect((await fetch(url!, { signal: AbortSignal.timeout(2500) })).status).toBe(200);
    if (!noOpen) { await until(() => observed() !== null); expect(observed()!.argv).toEqual([url!]); }
    return { child, url: url!, observed, signals, output: () => output, errors: () => errors, close };
  } catch (error) { await close(); throw error; }
}

test("opener success confirms only the command completion and passes the exact service URL as its sole argument", async () => {
  const f = await fixture("success");
  try { await until(() => f.output().includes("打开命令已完成")); expect(f.output()).not.toContain("浏览器窗口已打开"); expect(f.errors()).toBe(""); }
  finally { await f.close(); }
});

test("opener failure falls back to the actual URL without claiming a browser window opened", async () => {
  const f = await fixture("failure");
  try { await until(() => f.errors().includes("无法自动打开")); expect(f.errors()).toContain(f.url); expect(f.output()).not.toContain("打开命令已完成"); }
  finally { await f.close(); }
});

test("opener observation expires after five seconds without killing a still-running opener", async () => {
  const f = await fixture("hold");
  try {
    await until(() => f.errors().includes("尚未确认"), 7500);
    const stub = f.observed()!; expect(alive(stub.pid, stub.starttime)).toBe(true);
    expect(existsSync(f.signals)).toBe(false); expect(f.errors()).toContain("尚未确认"); expect(f.errors()).toContain(f.url);
    expect((await fetch(f.url, { signal: AbortSignal.timeout(2500) })).status).toBe(200);
  } finally { await f.close(); }
}, 12000);

for (const signal of ["SIGINT", "SIGTERM"] as const) test(`${signal} stops only the CLI service promptly while its opener survives in an independent process group`, async () => {
  const f = await fixture("hold");
  try {
    const stub = f.observed()!;
    // Terminal signals target the CLI foreground process group, never the scope.
    process.kill(-f.child.pid, signal);
    expect(await bounded(f.child.exited)).toBe(0);
    expect(alive(stub.pid, stub.starttime)).toBe(true); expect(stub.group).not.toBe(f.child.pid);
    expect(existsSync(f.signals)).toBe(false);
    await expect(fetch(f.url, { signal: AbortSignal.timeout(2500) })).rejects.toThrow();
    console.log(JSON.stringify({ signal, cliExited: true, openerSurvived: true, independentGroup: true }));
  } finally { await f.close(); }
}, 10000);

test("--no-open serves the page without invoking any PATH opener", async () => {
  const f = await fixture("hold", true);
  try { await Bun.sleep(250); expect(f.observed()).toBeNull(); expect(f.output()).not.toContain("打开命令已完成"); }
  finally { await f.close(); }
});
