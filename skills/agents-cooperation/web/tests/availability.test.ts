import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG, activeBlocks, resolveDispatch, type Config } from "../../scripts/agents-config.ts";
import { listBlocks, openState, upsertBlock } from "../../scripts/lib/state-db.ts";
import { Database } from "bun:sqlite";
import { planAvailability } from "../lib/availability.ts";
import { startServer } from "../server.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quota-backend-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "config.json");
  writeFileSync(file, readFileSync(DEFAULT_CONFIG));
  const state = join(root, "custom.sqlite");
  const home = join(root, "home");
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, AGENTS_COOPERATION_CONFIG: file, AGENTS_COOPERATION_STATE: state };
  const entrypoint = join(root, "index.html");
  writeFileSync(entrypoint, '<!doctype html><link rel="stylesheet" href="./style.css"><script type="module" src="./app.ts"></script>');
  writeFileSync(join(root, "app.ts"), "");
  writeFileSync(join(root, "style.css"), "");
  return { file, state, env, home, entrypoint, configBytes: readFileSync(file) };
}
async function http(f: Omit<ReturnType<typeof fixture>, "env"> & { env: Record<string, string | undefined> }) {
  const server = await startServer({ env: f.env, port: 0, entrypoint: f.entrypoint });
  cleanup.push(() => server.stop(true));
  const url = `http://127.0.0.1:${server.port}`;
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(url + path, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: url }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { server, url, request };
}
const bytes = (path: string) => ({
  main: existsSync(path) ? readFileSync(path) : null,
  wal: existsSync(path + "-wal") ? readFileSync(path + "-wal") : null,
});
const storedBlocks = (path: string) => {
  const db = new Database(path, { readonly: true, create: false });
  try { return listBlocks(db); } finally { db.close(); }
};

test("explicit engine quota keeps metadata and other rows, rejects a bad batch without writing, and expires through activeBlocks", async () => {
  const rolled = planAvailability({ updates: [{ engine: "codex", release_at: "2099-02-30T10:30:00-04:00" }] }, { codex: {} }, Date.parse("2026-10-18T00:00:00Z"));
  expect(rolled).toEqual({ updates: [], issues: [{ path: "$.updates[0].release_at", message: "恢复时间无效。" }] });
  const f = fixture();
  const db = openState(f.state);
  const codex = { engine: "codex", reason: "keep-me", since: "2026-01-01T00:00:00Z", release_at: "2099-01-01T00:00:00Z", by: "codex_owner" };
  const model = { engine: "codex", model: "other-model", reason: "model-keep", since: "2026-01-02T00:00:00Z", release_at: "2099-12-01T00:00:00Z", by: "someone" };
  const qoder = { engine: "qoder", reason: "other-engine", since: "2026-01-03T00:00:00Z", release_at: "2000-01-01T00:00:00Z", by: "codex_owner" };
  upsertBlock(db, codex); upsertBlock(db, model); upsertBlock(db, qoder);
  db.close();
  const before = bytes(f.state);
  const h = await http(f);
  const release = "2099-06-01T03:04:05-04:00";
  const initial = await (await h.request("/api/availability")).json();
  expect(initial).toMatchObject({ ok: true, status: "ready", warnings: [], blocks: [codex, model, qoder] });
  expect(initial.path).toBe(resolve(f.state));
  const bad = [
    {},
    { updates: [null] },
    { updates: [{ engine: 1, release_at: release }] },
    { updates: [{ engine: "codex", release_at: release }, { engine: "codex", release_at: null }] },
    { updates: [{ engine: "not-an-engine", release_at: release }] },
    { updates: [{ engine: "constructor", release_at: release }] },
    { updates: [{ engine: "codex", release_at: "2099-06-01T03:04:05" }] },
    { updates: [{ engine: "codex", release_at: "+2h" }] },
    { updates: [{ engine: "codex", release_at: "2000-01-01T00:00:00Z" }] },
    { updates: [{ engine: "codex", release_at: "2099-13-40T00:00:00Z" }] },
    { updates: [{ engine: "codex", release_at: "2099-02-30T10:30:00-04:00" }] },
    { updates: [{ engine: "codex", release_at: 1 }] },
    { updates: [{ engine: "claude", release_at: "2099-07-01T00:00:00Z" }, { engine: "codex", release_at: "+2h" }] },
  ];
  for (const body of bad) {
    const response = await h.request("/api/availability", "PUT", body);
    expect(response.status).toBe(422);
    const payload = await response.json();
    expect(payload.ok).toBe(false);
    expect(payload.issues.length).toBeGreaterThan(0);
  }
  expect((await h.request("/api/availability", "GET", undefined, { host: "evil.example" })).status).toBe(403);
  expect((await h.request("/api/availability", "PUT", { updates: [] }, { origin: "http://evil.example" })).status).toBe(403);
  const naked = await fetch(h.url + "/api/availability", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ updates: [{ engine: "codex", release_at: release }] }) });
  expect(naked.status).toBe(403);
  const afterRejects = bytes(f.state);
  expect(afterRejects.main).toEqual(before.main);
  expect(afterRejects.wal === null || afterRejects.wal.byteLength === 0).toBe(true);
  expect(existsSync(f.state + "-journal")).toBe(false);
  expect(storedBlocks(f.state)).toEqual([codex, model, qoder]);
  expect(readFileSync(f.file)).toEqual(f.configBytes);

  const created = "2099-07-01T00:00:00Z";
  const saved = await (await h.request("/api/availability", "PUT", { updates: [{ engine: "codex", release_at: release }, { engine: "claude", release_at: created }] })).json();
  const codexUpdated = { ...codex, release_at: release };
  expect(saved.ok).toBe(true);
  expect(saved.blocks.slice(0, 3)).toEqual([codexUpdated, model, qoder]);
  expect(saved.blocks[3]).toMatchObject({ engine: "claude", reason: "用户设置额度恢复时间", release_at: created, by: "web" });
  expect(saved.blocks[3].model).toBeUndefined();
  expect(saved.blocks[3].since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(Math.abs(Date.parse(saved.blocks[3].since) - Date.now())).toBeLessThan(60_000);
  const again = await (await h.request("/api/availability")).json();
  expect(again).toEqual(saved);
  const at = Date.parse(release);
  expect(activeBlocks({ version: 1, blocks: saved.blocks }, at - 1).filter(block => block.model === undefined).map(block => block.engine)).toEqual(["codex", "claude"]);
  expect(activeBlocks({ version: 1, blocks: saved.blocks }, at).some(block => block.engine === "codex" && block.model === undefined)).toBe(false);
  expect(resolveDispatch(JSON.parse(f.configBytes.toString("utf8")) as Config, activeBlocks({ version: 1, blocks: saved.blocks }, at), { owner: "codex_owner", class: "judgment" }, f.home).worker).toBe("codex_worker");

  const cleared = await (await h.request("/api/availability", "PUT", { updates: [{ engine: "codex", release_at: null }] })).json();
  expect(cleared.blocks).toEqual([model, qoder, saved.blocks[3]]);
  expect(storedBlocks(f.state)).toEqual(cleared.blocks);
  expect(readFileSync(f.file)).toEqual(f.configBytes);
});

test("missing state stays missing until an explicit update creates only this private database", async () => {
  const f = fixture();
  expect(existsSync(f.state)).toBe(false);
  const h = await http(f);
  const missing = await (await h.request("/api/availability")).json();
  expect(missing).toMatchObject({ ok: true, status: "missing", warnings: [], blocks: [] });
  expect(existsSync(f.state)).toBe(false);
  const empty = await h.request("/api/availability", "PUT", { updates: [] });
  expect(empty.status).toBe(200);
  expect(await empty.json()).toMatchObject({ ok: true, status: "missing", blocks: [] });
  expect(existsSync(f.state)).toBe(false);
  const rejected = await h.request("/api/availability", "PUT", { updates: [{ engine: "codex", release_at: "+1d" }] });
  expect(rejected.status).toBe(422);
  expect(existsSync(f.state)).toBe(false);
  const release = "2099-08-01T01:02:03Z";
  const created = await (await h.request("/api/availability", "PUT", { updates: [{ engine: "codex", release_at: release }] })).json();
  expect(created).toMatchObject({ ok: true, status: "ready", warnings: [] });
  expect(created.blocks).toEqual([{ engine: "codex", reason: "用户设置额度恢复时间", since: created.blocks[0].since, release_at: release, by: "web" }]);
  expect(existsSync(f.state)).toBe(true);
  expect(statSync(f.state).mode & 0o777).toBe(0o600);
  expect(readFileSync(f.file)).toEqual(f.configBytes);
});

test("uncertain legacy cannot be bypassed by PUT and neither call creates or edits state", async () => {
  const f = fixture();
  const env: Record<string, string | undefined> = { ...f.env, AGENTS_COOPERATION_STATE: undefined };
  const directory = join(f.home, ".local/state/agents-cooperation");
  mkdirSync(directory, { recursive: true });
  const legacy = join(directory, "availability.json");
  const legacyBytes = "{\"version\":1,\"blocks\":[]}";
  writeFileSync(legacy, legacyBytes);
  const sqlite = join(directory, "state.sqlite");
  const h = await http({ ...f, env });
  for (const call of [h.request("/api/availability"), h.request("/api/availability", "PUT", { updates: [{ engine: "codex", release_at: "2099-06-01T03:04:05Z" }] })]) {
    const response = await call;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, certain: false, state: { status: "uncertain", blocks: [] } });
  }
  expect(existsSync(sqlite)).toBe(false);
  expect(readFileSync(legacy, "utf8")).toBe(legacyBytes);
  expect(readFileSync(f.file)).toEqual(f.configBytes);
});
