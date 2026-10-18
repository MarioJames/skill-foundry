import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync, symlinkSync, existsSync, cpSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import * as promises from "node:fs/promises";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { DEFAULT_CONFIG, activeBlocks } from "../../scripts/agents-config.ts";
import { openState, upsertBlock } from "../../scripts/lib/state-db.ts";
import { ConfigStore } from "../lib/config-store.ts";
import { readState } from "../lib/read-state.ts";
import { startServer, BODY_LIMIT } from "../server.ts";
import { writeSyntheticPackage } from "./cli-fixture.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const config = () => JSON.parse(readFileSync(DEFAULT_CONFIG, "utf8"));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "config-web-backend-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "config.json");
  const state = join(root, "custom.sqlite");
  const env = { ...process.env, HOME: join(root, "home"), AGENTS_COOPERATION_CONFIG: file, AGENTS_COOPERATION_STATE: state };
  const entrypoint = join(root, "index.html");
  writeFileSync(entrypoint, '<!doctype html><link rel="stylesheet" href="./style.css"><script type="module" src="./app.ts"></script><div>测试页面</div>');
  writeFileSync(join(root, "app.ts"), 'document.title="本地测试";');
  writeFileSync(join(root, "style.css"), 'body{color:rgb(10,20,30)}');
  return { root, file, state, env, entrypoint };
}
async function http(f: Omit<ReturnType<typeof fixture>, "env"> & { env: Record<string, string | undefined> }) {
  const server = await startServer({ env: f.env, port: 0, entrypoint: f.entrypoint });
  cleanup.push(() => server.stop(true));
  const url = `http://127.0.0.1:${server.port}`;
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(url + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: url }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { server, url, request };
}

test("missing config has its own revision, first save preserves assets and fields; corrupt JSON never falls back", async () => {
  const f = fixture(), asset = readFileSync(DEFAULT_CONFIG), h = await http(f);
  const initial = await (await h.request("/api/config")).json();
  expect(initial).toMatchObject({ revision: '"missing"', exists: false, source: DEFAULT_CONFIG, target: f.file });
  expect(initial.config.$schema.startsWith("/")).toBe(true);
  const draft = initial.config; draft.workers.codex_worker.description = "保留字段";
  const saved = await h.request("/api/config", "PUT", { config: draft }, { "if-match": initial.revision });
  expect(saved.status).toBe(200);
  const snapshot = await saved.json();
  expect(snapshot).toMatchObject({ exists: true, source: f.file, target: f.file });
  expect(snapshot.revision).not.toBe(initial.revision);
  expect((await (await h.request("/api/config")).json()).revision).toBe(snapshot.revision);
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(f.file, "utf8")).workers.codex_worker.description).toBe("保留字段");
  expect(readFileSync(DEFAULT_CONFIG)).toEqual(asset);
  writeFileSync(f.file, '{"secret":"DO_NOT_EXPOSE",broken');
  const broken = await h.request("/api/config");
  expect(broken.status).toBe(500);
  expect(await broken.text()).not.toContain("DO_NOT_EXPOSE");
  expect(() => new ConfigStore(DEFAULT_CONFIG, f.env)).toThrow("默认配置资产");
  const alias = join(f.root, "assets-alias"); symlinkSync(resolve(DEFAULT_CONFIG, ".."), alias);
  expect(() => new ConfigStore(join(alias, "config.default.json"), f.env)).toThrow("默认配置资产");
  const defaultStore = new ConfigStore(undefined, { ...f.env, AGENTS_COOPERATION_CONFIG: undefined });
  expect(defaultStore.target).toBe(join(f.env.HOME, ".config/agents-cooperation/config.json"));
  const defaultInitial = await defaultStore.read();
  expect(defaultInitial.revision).toBe('"missing"');
  const defaultSaved = await defaultStore.save(defaultInitial.config, defaultInitial.revision);
  expect(defaultSaved).toMatchObject({ source: defaultStore.target, exists: true });
  expect(readFileSync(DEFAULT_CONFIG)).toEqual(asset);
});

test("If-Match, concurrent saves, outside edits and write/rename failures preserve the old config and recover the queue", async () => {
  const f = fixture(), h = await http(f);
  const initial = await (await h.request("/api/config")).json();
  for (const match of [undefined, "*", 'W/"missing"', '"bogus"']) {
    expect((await h.request("/api/config", "PUT", { config: config() }, match ? { "if-match": match } : {})).status).toBe(428);
  }
  const responses = await Promise.all([h.request("/api/config", "PUT", { config: config() }, { "if-match": initial.revision }), h.request("/api/config", "PUT", { config: config() }, { "if-match": initial.revision })]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  const first = await responses.find(r => r.status === 200)!.json();
  writeFileSync(f.file, JSON.stringify({ ...config(), $schema: "/externally-edited" }));
  expect((await h.request("/api/config", "PUT", { config: config() }, { "if-match": first.revision })).status).toBe(409);
  const current = await (await h.request("/api/config")).json();
  const bytes = readFileSync(f.file);
  for (const method of ["open", "rename"] as const) {
    const failure = spyOn(promises, method).mockRejectedValueOnce(new Error("SENSITIVE_IO_FAILURE"));
    try {
      const failed = await h.request("/api/config", "PUT", { config: config() }, { "if-match": current.revision });
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain("SENSITIVE_IO_FAILURE");
    } finally { failure.mockRestore(); }
    expect(readFileSync(f.file)).toEqual(bytes);
    expect(readdirSync(f.root).filter(n => n.startsWith(".agents-config-"))).toEqual([]);
  }
  expect((await h.request("/api/config", "PUT", { config: config() }, { "if-match": current.revision })).status).toBe(200);
});

test("all pages, actual bundled assets, APIs and errors enforce exact Host; APIs enforce Origin/JSON and actual stream bytes", async () => {
  const f = fixture(), h = await http(f);
  const page = await h.request("/");
  expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  const html = await page.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(m => m[1]!);
  expect(assets.some(p => p.endsWith(".js"))).toBe(true);
  expect(assets.some(p => p.endsWith(".css"))).toBe(true);
  for (const path of ["/", ...assets, "/api/config", "/api/availability", "/api/validate", "/missing", "/_bun/hmr"]) {
    for (const host of ["evil.example", "localhost:1", "127.0.0.1:1", `localhost:${h.server.port}.evil`]) expect((await h.request(path, "GET", undefined, { host })).status).toBe(403);
  }
  for (const asset of assets) expect((await h.request(asset)).status).toBe(200);
  expect((await h.request("/api/config", "GET", undefined, { host: `localhost:${h.server.port}` })).status).toBe(200);
  expect((await h.request("/_bun/hmr")).status).toBe(404);
  expect((await h.request("/api/validate", "POST", { config: config() }, { origin: "http://evil.example" })).status).toBe(403);
  expect((await h.request("/api/validate", "POST", { config: config() }, { origin: `http://localhost:${h.server.port}` })).status).toBe(403);
  expect((await h.request("/api/validate", "POST", { config: config() }, { "content-type": "text/plain" })).status).toBe(415);
  const invalid = await fetch(h.url + "/api/validate", { method: "POST", headers: { origin: h.url, "content-type": "application/json" }, body: "secret invalid json" });
  expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain("secret");
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 6; i++) controller.enqueue(new Uint8Array(BODY_LIMIT / 4).fill(32)); controller.close(); } });
  const tooLarge = await fetch(h.url + "/api/validate", { method: "POST", headers: { origin: h.url, "content-type": "application/json" }, body: stream });
  expect(tooLarge.status).toBe(413);
  expect(tooLarge.headers.get("access-control-allow-origin")).toBeNull();
});

test("validation checks the complete unsaved draft; unknown fields and dangling references stay diagnostic", async () => {
  const f = fixture(), h = await http(f), draft = config();
  draft.owners.codex_owner.max_parallel = 0;
  const invalid = await h.request("/api/validate", "POST", { config: draft });
  expect(invalid.status).toBe(422);
  expect((await invalid.json()).issues).toContainEqual({ path: "$.owners.codex_owner.max_parallel", message: "must be >= 1" });
  draft.owners.codex_owner.max_parallel = 1; delete draft.workers.codex_worker;
  const dangling = await h.request("/api/validate", "POST", { config: draft });
  expect(dangling.status).toBe(422);
  expect((await dangling.json()).issues.some((i: { path: string }) => i.path.includes(".workers["))).toBe(true);
  const unknown = config(); unknown.custom = "keep invalid";
  expect((await (await h.request("/api/validate", "POST", { config: unknown })).json()).issues).toContainEqual({ path: "$.custom", message: "unknown property" });
  const unsaved = config(); unsaved.workers.codex_worker.model = "draft-model";
  unsaved.$schema = "/browser-annotation-must-never-be-read";
  const valid = await h.request("/api/validate", "POST", { config: unsaved });
  expect(valid.status).toBe(200);
  expect(await valid.json()).toEqual({ok:true,issues:[]});
  expect(existsSync(f.state)).toBe(false); expect(existsSync(f.file)).toBe(false);
});

test("default legacy/recovery evidence is uncertain, completely absent state stays absent, and custom state does not scan legacy", async () => {
  const f = fixture();
  const env = { ...f.env, AGENTS_COOPERATION_STATE: undefined };
  const directory = join(env.HOME, ".local/state/agents-cooperation");
  expect(readState(undefined, env).status).toBe("missing"); expect(existsSync(directory)).toBe(false);
  mkdirSync(directory, { recursive: true });
  const legacy = join(directory, "availability.json");
  const bytes = JSON.stringify({ version: 1, blocks: [{ engine: "codex", reason: "legacy", since: "2026-01-01T00:00:00Z" }] });
  writeFileSync(legacy, bytes);
  const status = readState(undefined, env);
  expect(status.status).toBe("uncertain"); expect(status.warnings.length).toBeGreaterThan(0);
  expect(existsSync(join(directory, "state.sqlite"))).toBe(false); expect(readFileSync(legacy, "utf8")).toBe(bytes);
  const h = await http({ ...f, env });
  const uncertain = await h.request("/api/availability");
  expect(uncertain.status).toBe(503); const result = await uncertain.json(); expect(result.certain).toBe(false); expect(result.state.status).toBe("uncertain");
  rmSync(legacy);
  const path = join(directory, "state.sqlite"), db = openState(path); db.close();
  const recovery = legacy + ".importing-unaccounted"; writeFileSync(recovery, bytes);
  const before = readFileSync(path);
  expect(readState(undefined, env).status).toBe("uncertain"); expect(readFileSync(path)).toEqual(before); expect(readFileSync(recovery, "utf8")).toBe(bytes);
  expect(readState(f.state, env).status).toBe("missing");
});

test("a recreated legacy file stays ready when that source was already imported", async () => {
  const f = fixture();
  const env = { ...f.env, AGENTS_COOPERATION_STATE: undefined };
  const directory = join(env.HOME, ".local/state/agents-cooperation");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "state.sqlite");
  const legacy = resolve(join(directory, "availability.json"));
  const snapshot = join(directory, "availability.json.importing-recorded");
  const snapshotBytes = '{"version":1,"blocks":[]}';
  const db = openState(path);
  const block = { engine: "claude", reason: "sqlite", since: "2026-01-01T00:00:00Z" };
  upsertBlock(db, block);
  writeFileSync(snapshot, snapshotBytes);
  const sha = createHash("sha256").update(snapshotBytes).digest("hex");
  const record = JSON.stringify([{ snapshot, sha256: sha, source: legacy }]);
  db.query("INSERT INTO meta(key,value) VALUES('availability_imports',?)").run(record);
  db.close();
  const legacyBytes = JSON.stringify({ version: 1, blocks: [{ engine: "codex", reason: "recreated", since: "2026-02-01T00:00:00Z" }] });
  writeFileSync(legacy, legacyBytes);
  const before = readFileSync(path);
  const state = readState(undefined, env);
  expect(state.status).toBe("ready");
  expect(state.blocks).toEqual([block]);
  expect(state.warnings.join("\n")).toContain("SQLite");
  expect(readFileSync(path)).toEqual(before);
  expect(readFileSync(legacy, "utf8")).toBe(legacyBytes);
  expect(readFileSync(snapshot, "utf8")).toBe(snapshotBytes);
  expect(existsSync(path + "-journal")).toBe(false);
  const h = await http({ ...f, env });
  const available = await h.request("/api/availability");
  expect(available.status).toBe(200);
  const body = await available.json();
  expect(body.status).toBe("ready");
  expect(body.warnings.join("\n")).toContain("SQLite");
  expect(body.blocks).toEqual([block]);
  expect(readFileSync(legacy, "utf8")).toBe(legacyBytes);

  const mismatched = new Database(path);
  mismatched.query("UPDATE meta SET value=? WHERE key='availability_imports'").run(JSON.stringify([{ snapshot, sha256: "0".repeat(64), source: legacy }]));
  mismatched.close();
  const mismatchedBytes = readFileSync(path);
  expect(readState(undefined, env).status).toBe("uncertain");
  expect(readFileSync(path)).toEqual(mismatchedBytes);
  expect(readFileSync(snapshot, "utf8")).toBe(snapshotBytes);

  const broken = new Database(path);
  broken.query("UPDATE meta SET value=? WHERE key='availability_imports'").run("{");
  broken.close();
  const brokenBytes = readFileSync(path);
  expect(readState(undefined, env).status).toBe("uncertain");
  expect(readFileSync(path)).toEqual(brokenBytes);
  expect(readFileSync(legacy, "utf8")).toBe(legacyBytes);
});

test("default path validates import records when no legacy filename remains", () => {
  const f = fixture();
  const env = { ...f.env, AGENTS_COOPERATION_STATE: undefined };
  const directory = join(env.HOME, ".local/state/agents-cooperation");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "state.sqlite");
  const db = openState(path);
  db.query("INSERT INTO meta(key,value) VALUES('availability_imports',?)").run("{");
  db.close();
  const legacyName = (name: string) => name === "availability.json" || name.startsWith("availability.json.importing-");
  const before = readFileSync(path);
  expect(readdirSync(directory).some(legacyName)).toBe(false);
  expect(readState(undefined, env).status).toBe("uncertain");
  expect(readFileSync(path)).toEqual(before);

  const snapshot = join(f.root, "recorded-snapshot.json");
  const snapshotBytes = "{\"version\":1,\"blocks\":[]}";
  writeFileSync(snapshot, snapshotBytes);
  const repaired = new Database(path);
  repaired.query("UPDATE meta SET value=? WHERE key='availability_imports'").run(JSON.stringify([{ snapshot, sha256: "f".repeat(64), source: join(directory, "availability.json") }]));
  repaired.close();
  const repairedBytes = readFileSync(path);
  expect(readdirSync(directory).some(legacyName)).toBe(false);
  expect(readState(undefined, env).status).toBe("uncertain");
  expect(readFileSync(path)).toEqual(repairedBytes);
  expect(readFileSync(snapshot, "utf8")).toBe(snapshotBytes);
});

test("Web validation and saving reject own prototype-named unknown fields without changing the saved file", async () => {
  const f = fixture(); writeFileSync(f.file, JSON.stringify(config()));
  const before = readFileSync(f.file), h = await http(f);
  const initial = await (await h.request("/api/config")).json();
  for (const key of ["constructor", "toString", "__proto__"]) {
    const draft = { ...initial.config, ...JSON.parse(`{"${key}":"invalid draft"}`) };
    for (const [path, method] of [["/api/validate", "POST"], ["/api/config", "PUT"]]) {
      const response = await h.request(path!, method!, { config: draft }, { "if-match": initial.revision });
      expect(response.status).toBe(422);
      expect((await response.json()).issues).toContainEqual({ path: `$.${key}`, message: "unknown property" });
      expect(readFileSync(f.file)).toEqual(before);
    }
  }
  expect((await (await h.request("/api/config")).json()).revision).toBe(initial.revision);
  expect(existsSync(f.state)).toBe(false);
});

test("read-only SQLite preserves v1/v2 bytes, permissions and expired rows; wrong app/version/data cannot look available", () => {
  const f = fixture();
  const path = f.state, db = openState(path);
  const now = Date.parse("2026-10-17T12:00:00Z");
  for (const delta of [-1, 0, 1]) upsertBlock(db, { engine: "codex", model: String(delta), reason: "boundary", since: "2026-01-01T00:00:00Z", release_at: new Date(now + delta).toISOString() });
  db.close();
  const before = readFileSync(path), mode = statSync(path).mode;
  const state = readState(path, f.env);
  expect(state.status).toBe("ready"); expect(state.blocks).toHaveLength(3);
  expect(activeBlocks({ version: 1, blocks: state.blocks }, now).map(b => b.model)).toEqual(["1"]);
  expect(readFileSync(path)).toEqual(before); expect(statSync(path).mode).toBe(mode);
  const verify = new Database(path, { readonly: true, create: false });
  expect((verify.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(2);
  expect(verify.query("SELECT COUNT(*) AS count FROM blocks").get()).toEqual({ count: 3 }); verify.close();
  const historical = join(f.root, "v1.sqlite"), old = new Database(historical);
  old.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);INSERT INTO meta VALUES('app','agents-cooperation');CREATE TABLE blocks(engine TEXT,model TEXT,reason TEXT,since TEXT,release_at TEXT,by TEXT);PRAGMA user_version=1;"); old.close();
  const v1Bytes = readFileSync(historical); expect(readState(historical, f.env).status).toBe("ready"); expect(readFileSync(historical)).toEqual(v1Bytes);
  for (const version of [0, 999]) { const foreign = join(f.root, `version-${version}.sqlite`), d = new Database(foreign); d.exec(`PRAGMA user_version=${version}`); d.close(); expect(readState(foreign, f.env).status).toBe("uncertain"); }
  const wrong = new Database(historical); wrong.exec("UPDATE meta SET value='foreign'"); wrong.close(); expect(readState(historical, f.env).status).toBe("uncertain");
});

test("read-only state sees committed blocks still in live WAL without changing main/WAL bytes or migration metadata", () => {
  const f = fixture(), db = openState(f.state);
  try {
    db.exec("PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE)");
    const block = { engine: "codex", reason: "live WAL", since: "2026-01-01T00:00:00Z" };
    upsertBlock(db, block);
    db.query("INSERT INTO meta(key,value) VALUES('availability_imports',?)").run("[]");
    const main = readFileSync(f.state), wal = readFileSync(f.state + "-wal"), mode = statSync(f.state).mode;
    expect(wal.byteLength).toBeGreaterThan(0);
    const state = readState(f.state, f.env);
    expect(state.status).toBe("ready"); expect(state.blocks).toEqual([block]);
    expect(readFileSync(f.state)).toEqual(main); expect(readFileSync(f.state + "-wal")).toEqual(wal); expect(statSync(f.state).mode).toBe(mode);
    expect(db.query("SELECT value FROM meta WHERE key='availability_imports'").get()).toEqual({ value: "[]" });
    expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(2);
    expect(db.query("SELECT COUNT(*) AS count FROM blocks").get()).toEqual({ count: 1 });
  } finally { db.close(); }
});

test("ordinary CLI has no Web dependency; missing direct frontend dependency gives one install command; --no-open starts dynamically and Ctrl-C releases its port", async () => {
  const f = fixture(), skill = join(f.root, "skill"), source = resolve(import.meta.dir, "../..");
  cpSync(join(source, "scripts"), join(skill, "scripts"), { recursive: true });
  cpSync(join(source, "assets"), join(skill, "assets"), { recursive: true });
  writeFileSync(f.file, JSON.stringify(config()));
  const script = join(skill, "scripts/agents-config.ts");
  const ordinary = Bun.spawnSync([process.execPath, script, "validate"], { env: f.env });
  expect(ordinary.exitCode).toBe(0); expect(JSON.parse(ordinary.stdout.toString()).ok).toBe(true);
  mkdirSync(join(skill, "web"));
  for (const file of ["launch.ts", "server.ts", "package.json"]) cpSync(join(source, "web", file), join(skill, "web", file));
  cpSync(join(source, "web/lib"), join(skill, "web/lib"), { recursive: true });
  const modules = join(skill, "web/node_modules"); mkdirSync(modules);
  const manifest = JSON.parse(readFileSync(join(skill, "web/package.json"), "utf8"));
  // Resolve every direct dependency except a real frontend dependency. This
  // catches launchers that only check React and miss the rest of the manifest.
  for (const name of Object.keys(manifest.dependencies).filter(name => name !== "lucide-react")) {
    writeSyntheticPackage(modules, name);
  }
  const missing = Bun.spawnSync([process.execPath, script, "web", "--no-open", "--port", "0"], { env: f.env });
  expect(missing.exitCode).toBe(1); expect(missing.stderr.toString().match(/bun install --cwd/g)).toHaveLength(1); expect(missing.stdout.toString()).not.toContain("已启动");
  writeSyntheticPackage(modules, "lucide-react");
  for (const file of ["index.html", "app.ts", "style.css"]) cpSync(join(f.root, file), join(skill, "web", file));
  const bin = join(f.root, "bin"); mkdirSync(bin); const opened = join(f.root, "browser-was-opened");
  writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\ntouch '${opened}'\n`, { mode: 0o755 });
  const unit = `dev-config-web-cli-${randomUUID()}.scope`;
  const child = Bun.spawn(["systemd-run", "--user", "--scope", "--collect", `--unit=${unit}`, "-p", "MemoryHigh=8G", "-p", "MemoryMax=10G", "--", process.execPath, script, "web", "--no-open", "--port", "0"], { env: { ...f.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
  let output = "", errors = "";
  const read = async (stream: ReadableStream<Uint8Array>, append: (value: string) => void) => { for await (const chunk of stream) append(new TextDecoder().decode(chunk)); };
  const readers = [read(child.stdout, value => { output += value; }), read(child.stderr, value => { errors += value; })];
  try {
    const deadline = Date.now() + 15000;
    while (!/http:\/\/127\.0\.0\.1:\d+\//.test(output) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
    const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
    expect({ started: !!url, errors }).toMatchObject({ started: true });
    expect((await fetch(url! + "api/config")).status).toBe(200);
    const busyUnit = `dev-config-web-cli-busy-${randomUUID()}.scope`;
    const busy = Bun.spawn(["systemd-run", "--user", "--scope", "--collect", `--unit=${busyUnit}`, "-p", "MemoryHigh=8G", "-p", "MemoryMax=10G", "--", process.execPath, script, "web", "--no-open", "--port", new URL(url!).port], { env: f.env, stdout: "pipe", stderr: "pipe" });
    const busyOutput = new Response(busy.stdout).text(), busyErrors = new Response(busy.stderr).text();
    try {
      expect(await Promise.race([busy.exited, Bun.sleep(5000).then(() => -999)])).toBe(1);
      expect(await busyErrors).toContain("端口已被占用"); expect(await busyOutput).not.toContain("已启动");
    } finally { Bun.spawnSync(["systemctl", "--user", "stop", busyUnit], { stdout: "ignore", stderr: "ignore" }); if (busy.exitCode === null) busy.kill(); await busy.exited; await busyOutput; await busyErrors; }
    expect(existsSync(opened)).toBe(false);
    const signal = Bun.spawnSync(["systemctl", "--user", "kill", "--kill-whom=all", "--signal=SIGINT", unit]);
    expect(signal.exitCode).toBe(0);
    expect(await child.exited).toBe(0);
    await Promise.all(readers);
    await expect(fetch(url!)).rejects.toThrow();
    expect(existsSync(f.state)).toBe(false);
  } finally {
    Bun.spawnSync(["systemctl", "--user", "stop", unit], { stdout: "ignore", stderr: "ignore" });
    if (child.exitCode === null) child.kill();
    await child.exited; await Promise.all(readers);
  }
}, 30000);
