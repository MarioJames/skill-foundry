#!/usr/bin/env bun
// Runs inside the systemd scope created by `route-lane.ts --create-session`.
// Usage: bun session-launcher.ts --op-tag TAG NAME
// Exit 73: the session already exists (registered name or directory).
// Exit 74: existence could not be established. Exit 64: bad arguments.
// Exit 75: the directory this launcher just created was written to by someone else before the server started.
// The session directory is claimed with an atomic mkdir (not recursive on the last component), so a concurrent
// creator of the same name loses. The server is spawned only while that directory is still empty, its pid is
// printed on stdout, and the launcher exits; the scope lives on with the server.
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const fail = (code: number, message: string) => { console.error(message); return code; };
const present = (path: string) => { try { lstatSync(path); return true; } catch { return false; } };

// The last check before the fork: anything already inside the freshly claimed directory belongs to someone else.
export function startIfEmpty(dir: string, start: () => number): number {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return fail(74, `cannot list ${dir}`); }
  if (entries.length > 0) return fail(75, `session directory was written to before the server started: ${dir}`);
  let pid: number;
  try { pid = start(); } catch (error) { return fail(74, `cannot start herdr server: ${(error as Error).message}`); }
  console.log(String(pid));
  return 0;
}

export function launch(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  if (args.length !== 3 || args[0] !== "--op-tag") return fail(64, "usage: session-launcher.ts --op-tag TAG NAME");
  const name = args[2]!;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/u.test(name)) return fail(64, "invalid session name");

  const root = join(env.XDG_CONFIG_HOME || join(env.HOME ?? "", ".config"), "herdr", "sessions");
  const dir = join(root, name);
  try { mkdirSync(root, { recursive: true }); } catch { return fail(74, `cannot create ${root}`); }
  if (present(dir)) return fail(73, `session directory already exists: ${dir}`);

  let listed;
  try { listed = Bun.spawnSync(["herdr", "session", "list", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "inherit", env }); }
  catch { return fail(74, "herdr session list failed"); }
  if (listed.exitCode !== 0) return fail(74, "herdr session list failed");
  if (new RegExp(`"name"\\s*:\\s*"${name}"`, "u").test(listed.stdout.toString())) return fail(73, `session is already registered: ${name}`);

  try { mkdirSync(dir); } catch {
    return present(dir) ? fail(73, `session directory was created concurrently: ${dir}`) : fail(74, `cannot create ${dir}`);
  }
  return startIfEmpty(dir, () => {
    // The op tag identifies this call only; the long-lived server must not carry it.
    const { HERDR_LANE_OP_TAG: _tag, ...serverEnv } = env;
    const server = Bun.spawn(["herdr", "--session", name, "server"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: serverEnv });
    server.unref();
    return server.pid;
  });
}

if (import.meta.main) process.exit(launch(process.argv.slice(2)));
