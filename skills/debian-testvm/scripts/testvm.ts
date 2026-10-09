#!/usr/bin/env bun

import {
  chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync, writeSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { doctor } from "./lib/host-runtime.ts";

const help = `Usage: bun testvm.ts <command> [options]

  doctor
  image fetch [--release CODENAME]
  image ls [--release CODENAME]
  image new COMPONENT [--requires A,B]
  image build IMAGE [--refresh] [--release CODENAME] [--timeout SECONDS]
  image rm IMAGE [--release CODENAME]
  image prune
  up --purpose TEXT --release-when TEXT [--owner TEXT] [--image IMAGE] [--name NAME]
     [--release CODENAME] [--cpus N] [--memory MIB] [--disk SIZE] [--port PORT] [--bind ADDR]
     [--timeout SECONDS]
  annotate --name NAME [--owner TEXT] [--purpose TEXT] [--release-when TEXT]
  ls
  status --name NAME
  ssh --name NAME [-- COMMAND...]
  cp --name NAME SOURCE... DEST     Prefix VM paths with ':' (upload or download)
  start --name NAME
  stop --name NAME
  reset --name NAME
  rm --name NAME

Options:
  --root PATH     Store for built disks and VMs (default: ~/.local/share/debian-testvm)
  --config DIR    config.json and image components (default: ~/.config/debian-testvm)
  --help          Show this help

IMAGE is "debian" (the unmodified official cloud image) or components joined
with "+", e.g. docker+nodejs. A component is a directory with image.json and
provision.sh; the skill ships "docker" and DIR/images/<component>/ adds or
overrides components. Components are applied after their "requires", otherwise
by name, so the written order does not matter. Every built image is cached; a
missing or stale image is built on the largest ready image whose components
are a subset of it, adding the rest one layer at a time. Superseded layer
disks are deleted once no VM uses them, and a successful build deletes that
image's earlier failed build directories.
up delivers a running VM only after SSH and cloud-init are ready; reset
recreates its disk from the same built image.
Output: JSON (ssh/cp stream the remote command). Errors: JSON on stderr, nonzero exit.`;

type Config = {
  release?: string; defaultImage?: string; user?: string; password?: string; locale?: string; timezone?: string;
  bind?: string; cpus?: number; memory?: number; disk?: string; authorizedKeyFiles?: string[];
};
type Component = {
  name: string; source: "builtin" | "user"; dir: string; requires: string[]; description: string;
  groups: string[]; disk: string; build: { cpus: number; memory: number }; hash: string;
};
type Upstream = { file: string; at: string; source: string; sha512: string };
type Layer = {
  file: string; at: string; component: string; parent: string; parentFile: string; defHash: string;
  groups: string[]; versions: Record<string, string>;
};
type ImageIndex = { upstream?: Upstream; layers?: Record<string, Layer> };
type Instance = {
  name: string; release: string; image: string; imagePath: string; groups: string[]; instanceId: string;
  user: string; password: string; bind: string; port: number; cpus: number; memory: number;
  disk: string; locale: string; timezone: string; purpose: string; owner?: string; releaseWhen: string; createdAt: string;
};

const DEFAULT_RELEASE = "trixie";
const DEFAULT_IMAGE = "docker";
const UPSTREAM = "debian";
const PORT_RANGE = [22000, 22999] as const;
const BUILTIN_COMPONENTS = resolve(import.meta.dir, "../assets/images");
const COMPONENT_KEYS = new Set(["requires", "description", "groups", "disk", "build"]);

function fail(message: string): never { throw new Error(message); }
function sleep(ms: number) { return new Promise((done) => setTimeout(done, ms)); }
function log(message: string) { process.stderr.write(`[testvm] ${message}\n`); }
function stamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, ""); }
function digest(text: string) { return createHash("sha256").update(text).digest("hex").slice(0, 12); }

function run(cmd: string[], options: { cwd?: string } = {}) {
  const result = Bun.spawnSync({ cmd, cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail(`${basename(cmd[0])} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`);
  return result.stdout.toString().trimEnd();
}

function readJson<T>(path: string, fallback?: T): T {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    fail(`Missing ${path}`);
  }
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch (error) {
    fail(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

function writeJson(path: string, data: unknown, mode = 0o600) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode, flag: "wx" });
  renameSync(temp, path);
}

function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

// Lock file holding the owner's PID; a lock whose owner died is reclaimed. waitMs 0 fails immediately.
async function withLock<T>(path: string, waitMs: number, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(readFileSync(path, "utf8").trim());
      if (!owner || !pidAlive(owner)) { rmSync(path, { force: true }); continue; }
      if (Date.now() >= deadline) fail(`Another operation holds ${basename(path)} (pid ${owner}); retry after it finishes`);
      await sleep(500);
    }
  }
  try { return await fn(); } finally { rmSync(path, { force: true }); }
}

function validName(name: string, label = "Names") {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) fail(`${label} must be 1–31 lowercase letters, digits or hyphens, starting with a letter or digit (got "${name}")`);
  return name;
}

function validLocale(locale: string) {
  if (!/^[A-Za-z0-9_@.-]+$/.test(locale)) fail("locale must look like en_US.UTF-8");
  return locale;
}

function validRelease(release: string) {
  if (!/^[a-z]+$/.test(release)) fail("Release must be a Debian codename such as trixie");
  return release;
}

function positiveInt(value: string | number | undefined, label: string, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer`);
  return parsed;
}

function seconds(value: string | undefined, fallback: number) { return positiveInt(value, "--timeout", fallback) * 1000; }

function parseSize(size: string, label: string) {
  const match = /^(\d+)([KMGT]?)$/i.exec(size);
  if (!match) fail(`${label} must look like 20G`);
  return Number(match[1]) * 1024 ** "_KMGT".indexOf((match[2] || "_").toUpperCase());
}

function requireRuntime() {
  const report = doctor();
  if (!report.ok) fail(`Runtime not ready: ${report.problems.join("; ")}`);
}

function makeSeed(dir: string, userData: string, metaData: Record<string, string>, extra: string[] = []) {
  writeFileSync(join(dir, "user-data"), userData, { mode: 0o600 });
  writeFileSync(join(dir, "meta-data"), `${JSON.stringify(metaData)}\n`, { mode: 0o600 });
  const output = join(dir, "seed.iso");
  rmSync(output, { force: true });
  const files = ["user-data", "meta-data", ...extra];
  const genisoimage = Bun.which("genisoimage");
  run(genisoimage
    ? [genisoimage, "-quiet", "-output", output, "-volid", "cidata", "-joliet", "-rock", ...files]
    : ["xorriso", "-as", "genisoimage", "-quiet", "-output", output, "-volid", "cidata", "-joliet", "-rock", ...files], { cwd: dir });
  chmodSync(output, 0o600);
}

function cloudConfig(data: object) { return `#cloud-config\n${JSON.stringify(data, null, 2)}\n`; }

function qemuArgs(dir: string, options: { cpus: number; memory: number; netdev: string; daemonize: boolean; buildLog?: string }) {
  return [
    "qemu-system-x86_64", "-machine", "q35,accel=kvm", "-cpu", "host",
    "-smp", String(options.cpus), "-m", String(options.memory),
    "-drive", `if=virtio,file=${join(dir, "disk.qcow2")},format=qcow2,discard=unmap`,
    "-drive", `if=virtio,file=${join(dir, "seed.iso")},format=raw,readonly=on`,
    "-netdev", options.netdev, "-device", "virtio-net-pci,netdev=net0",
    "-device", "virtio-rng-pci", "-display", "none", "-monitor", "none",
    "-serial", `file:${join(dir, "serial.log")}`,
    // ttyS1 carries build output; getty on the console (ttyS0) would hang up a shared writer.
    ...(options.buildLog ? ["-serial", `file:${options.buildLog}`] : []),
    "-qmp", `unix:${join(dir, "qmp.sock")},server=on,wait=off`,
    "-pidfile", join(dir, "qemu.pid"),
    ...(options.daemonize ? ["-daemonize"] : []),
  ];
}

async function qmp(dir: string, command: string) {
  await new Promise<void>((done, reject) => {
    const socket = createConnection(join(dir, "qmp.sock"));
    let buffer = "";
    let step = 0;
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("QMP timeout")); });
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.QMP && step === 0) { step = 1; socket.write('{"execute":"qmp_capabilities"}\n'); }
        else if (message.return !== undefined && step === 1) { step = 2; socket.write(`{"execute":"${command}"}\n`); }
        else if ((message.return !== undefined || message.error) && step === 2) { socket.end(); done(); }
      }
    });
    socket.on("close", () => { if (step === 2) done(); });
  });
}

function vmPid(dir: string): number | null {
  const pidFile = join(dir, "qemu.pid");
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!pid || !pidAlive(pid)) return null;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes(join(dir, "disk.qcow2")) ? pid : null;
  } catch { return null; }
}

async function waitExit(dir: string, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!vmPid(dir)) return true;
    await sleep(500);
  }
  return !vmPid(dir);
}

async function stopVm(dir: string) {
  const pid = vmPid(dir);
  if (!pid) return "stopped";
  try { await qmp(dir, "system_powerdown"); } catch { /* fall through to quit */ }
  if (await waitExit(dir, 60_000)) return "powered-off";
  try { await qmp(dir, "quit"); } catch { process.kill(pid, "SIGTERM"); }
  if (await waitExit(dir, 15_000)) return "quit";
  fail(`QEMU process ${pid} did not exit; inspect it before retrying`);
}

function portFree(bind: string, port: number) {
  return new Promise<boolean>((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen({ host: bind, port, exclusive: true }, () => server.close(() => done(true)));
  });
}

function virtualSize(path: string) {
  return (JSON.parse(run(["qemu-img", "info", "--output", "json", "-U", path])) as { "virtual-size": number })["virtual-size"];
}

async function sha512(path: string) {
  const hasher = new Bun.CryptoHasher("sha512");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    if (entry.isFile()) return [path];
    fail(`Image components may only contain regular files and directories: ${path}`);
  }).sort();
}

function validComponentName(name: string) {
  validName(name, "Component names");
  if (name === UPSTREAM) fail(`"${UPSTREAM}" is the implicit base image, not a component`);
  return name;
}

function loadComponent(dir: string, source: Component["source"]): Component {
  const name = validComponentName(basename(dir));
  const raw = readJson<Record<string, unknown>>(join(dir, "image.json"));
  for (const key of Object.keys(raw)) if (!COMPONENT_KEYS.has(key)) fail(`${dir}/image.json: unknown key "${key}"`);
  if (!existsSync(join(dir, "provision.sh"))) fail(`${dir}: provision.sh is required`);
  const list = (key: string) => {
    if (raw[key] === undefined) return [];
    if (!Array.isArray(raw[key])) fail(`${dir}/image.json: "${key}" must be an array`);
    return (raw[key] as unknown[]).map(String);
  };
  const requires = list("requires").map(validComponentName);
  const groups = list("groups");
  for (const group of groups) if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(group)) fail(`${dir}/image.json: invalid group "${group}"`);
  const disk = typeof raw.disk === "string" ? raw.disk : "10G";
  parseSize(disk, `${dir}/image.json "disk"`);
  const build = (raw.build ?? {}) as { cpus?: number; memory?: number };
  const hasher = createHash("sha256");
  for (const file of listFiles(dir)) hasher.update(`${relative(dir, file)}\0`).update(readFileSync(file)).update("\0");
  return {
    name, source, dir, requires, description: typeof raw.description === "string" ? raw.description : "", groups, disk,
    build: { cpus: positiveInt(build.cpus, "build.cpus", 4), memory: positiveInt(build.memory, "build.memory", 4096) },
    hash: hasher.digest("hex"),
  };
}

function loadComponents(userDir: string) {
  const components = new Map<string, Component>();
  for (const [root, source] of [[BUILTIN_COMPONENTS, "builtin"], [userDir, "user"]] as const) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, entry.name, "image.json"))) {
        components.set(entry.name, loadComponent(join(root, entry.name), source));
      }
    }
  }
  return components;
}

// Framework steps around each component's provision.sh; every layer ends in the same clean-image state.
function buildRunner(release: string, component: string, image: string) {
  return `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive TESTVM_RELEASE=${release} TESTVM_COMPONENT=${component} TESTVM_IMAGE=${image}
mkdir -p /run/testvm-seed /root/testvm-component
mount -o ro LABEL=cidata /run/testvm-seed
tar -C /root/testvm-component -xf /run/testvm-seed/component.tar
umount /run/testvm-seed
cd /root/testvm-component
bash -euxo pipefail ./provision.sh
cd /
rm -rf /root/testvm-component
echo "TESTVM_VERSIONS debian=$(cat /etc/debian_version) kernel=$(ls /boot/vmlinuz-* | sort -V | tail -1 | sed 's|^/boot/vmlinuz-||')"
apt-get clean
rm -rf /var/lib/apt/lists/*
cloud-init clean --logs --machine-id
rm -f /etc/ssh/ssh_host_*
fstrim -av || true
`;
}

const PROVISION_TEMPLATE = `# Runs as root in a one-off build VM: bash -euxo pipefail, working directory = this component directory.
# Every file next to this script is available. Environment: TESTVM_RELEASE (Debian codename),
# TESTVM_COMPONENT, TESTVM_IMAGE (the full composition being built, e.g. docker+nodejs).
# Lower layers leave no apt lists, so update before installing. Do not create login users here.
# Report versions for image ls / up with lines such as: echo "TESTVM_VERSIONS node=$(node --version)"
apt-get update
apt-get install -y --no-install-recommends ca-certificates
`;

async function main() {
  const argv = Bun.argv.slice(2);
  const split = argv.indexOf("--");
  const { values: flags, positionals } = parseArgs({
    args: split === -1 ? argv : argv.slice(0, split),
    allowPositionals: true,
    options: {
      root: { type: "string" }, config: { type: "string" }, help: { type: "boolean" },
      release: { type: "string" }, name: { type: "string" }, image: { type: "string" },
      requires: { type: "string" }, refresh: { type: "boolean" },
      cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" },
      port: { type: "string" }, bind: { type: "string" }, purpose: { type: "string" }, timeout: { type: "string" },
      owner: { type: "string" }, "release-when": { type: "string" },
    },
  });
  const remote = split === -1 ? [] : argv.slice(split + 1);
  if (flags.help || positionals.length === 0) { console.log(help); return; }

  const command = positionals[0] === "image" ? `image ${positionals[1] ?? ""}` : positionals[0];
  const allowed: Record<string, string[]> = {
    doctor: [], "image fetch": ["release"], "image ls": ["release"], "image new": ["requires"],
    "image build": ["release", "timeout", "refresh"], "image rm": ["release"], "image prune": [],
    up: ["image", "name", "release", "cpus", "memory", "disk", "port", "bind", "purpose", "owner", "release-when", "timeout"],
    annotate: ["name", "owner", "purpose", "release-when"],
    ls: [], status: ["name"], ssh: ["name"], cp: ["name"], start: ["name", "timeout"], stop: ["name"],
    reset: ["name", "timeout"], rm: ["name"],
  };
  if (!allowed[command]) fail("Unknown command; use --help");
  for (const key of Object.keys(flags)) {
    if (!["root", "config", ...allowed[command]].includes(key)) fail(`--${key} is not valid for ${command}`);
  }
  const args = positionals.slice(command.startsWith("image ") ? 2 : 1);
  const takesImage = ["image new", "image build", "image rm"].includes(command);
  if (takesImage && args.length !== 1) fail(`${command} needs exactly one argument`);
  if (!takesImage && command !== "cp" && args.length) fail(`Unexpected arguments: ${args.join(" ")}`);
  if (remote.length && command !== "ssh") fail("'--' is only valid for ssh");

  const emit = (data: object) => console.log(JSON.stringify({ ok: true, ...data }, null, 2));
  if (command === "doctor") {
    const report = doctor();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  const root = resolve(flags.root ?? join(homedir(), ".local/share/debian-testvm"));
  const configDir = resolve(flags.config ?? join(homedir(), ".config/debian-testvm"));
  const userComponents = join(configDir, "images");
  const config = readJson<Config>(join(configDir, "config.json"), {});
  for (const dir of [root, join(root, "images"), join(root, "instances")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const storeLock = join(root, "store.lock");
  const release = validRelease(flags.release ?? config.release ?? DEFAULT_RELEASE);
  const imageDir = (name: string) => join(root, "images", validRelease(name));
  const indexPath = (name: string) => join(imageDir(name), "index.json");
  const readIndex = (name: string) => readJson<ImageIndex>(indexPath(name), {});
  const updateIndex = (name: string, change: (index: ImageIndex) => void) => withLock(storeLock, 60_000, async () => {
    const index = readIndex(name);
    change(index);
    writeJson(indexPath(name), index);
  });
  const instanceDir = (name: string) => join(root, "instances", validName(name));
  const required = (value: string | undefined, flag: string) => value ?? fail(`--${flag} is required`);
  const instances = () => readdirSync(join(root, "instances"))
    .filter((name) => existsSync(join(root, "instances", name, "instance.json")))
    .map((name) => readJson<Instance>(join(root, "instances", name, "instance.json")));

  const components = loadComponents(userComponents);
  // Order for a set of components: each after its requires (or those already in satisfied), ties by name.
  const orderComponents = (names: Iterable<string>, satisfied: string[] = []) => {
    const pending = [...new Set(names)].sort();
    const order: string[] = [];
    while (pending.length) {
      const next = pending.findIndex((name) => components.get(name)!.requires
        .every((dependency) => satisfied.includes(dependency) || order.includes(dependency)));
      if (next === -1) fail(`Unsatisfiable requires among ${pending.join(", ")}`);
      order.push(...pending.splice(next, 1));
    }
    return order;
  };
  const keyOf = (names: string[]) => (names.length ? orderComponents(names).join("+") : UPSTREAM);
  // An image is a set of components closed over requires, keyed in dependency-then-name order,
  // so "nodejs+docker" and "docker+nodejs" are the same image.
  const expand = (spec: string) => {
    if (spec === UPSTREAM) return UPSTREAM;
    const wanted = new Set<string>();
    const visit = (name: string, path: string[]) => {
      validComponentName(name);
      if (path.includes(name)) fail(`Component requires cycle: ${[...path, name].join(" -> ")}`);
      const component = components.get(name)
        ?? fail(path.length ? `Component ${path.at(-1)} requires unknown component ${name}` : `Unknown image component ${name}; see image ls`);
      wanted.add(name);
      for (const dependency of component.requires) visit(dependency, [...path, name]);
    };
    for (const name of spec.split("+")) visit(name, []);
    return keyOf([...wanted]);
  };
  const fileOf = (index: ImageIndex, key: string) => (key === UPSTREAM ? index.upstream?.file : index.layers?.[key]?.file);
  // Layer state: ready, stale (component or a lower layer changed since the build), missing, or orphaned (component gone).
  const layerState = (index: ImageIndex, key: string): "ready" | "stale" | "missing" | "orphaned" => {
    if (key === UPSTREAM) return index.upstream ? "ready" : "missing";
    const layer = index.layers?.[key];
    if (key.split("+").some((name) => !components.has(name))) return layer ? "orphaned" : "missing";
    if (!layer) return "missing";
    if (!layer.parent || layer.defHash !== components.get(layer.component)!.hash
      || layer.parentFile !== fileOf(index, layer.parent)) return "stale";
    return layerState(index, layer.parent) === "ready" ? "ready" : "stale";
  };

  // In-use disks come from each VM overlay's real backing file, not from instance metadata,
  // so VMs created by other CLI versions or with unreadable state still protect their image.
  const usedDisks = () => {
    const used = new Set<string>();
    for (const entry of readdirSync(join(root, "instances"))) {
      const disk = join(root, "instances", entry, "disk.qcow2");
      if (!existsSync(disk)) continue;
      const info = JSON.parse(run(["qemu-img", "info", "--output", "json", "-U", disk])) as { "full-backing-filename"?: string };
      if (info["full-backing-filename"]) used.add(resolve(info["full-backing-filename"]));
    }
    return used;
  };
  // Layer disks are a rebuildable cache: delete one as soon as it is neither current nor backing a VM.
  const reclaim = (name: string, file: string) => withLock(storeLock, 60_000, async () => {
    const index = readIndex(name);
    const path = join(imageDir(name), file);
    if (!/^layer-[0-9a-f]{12}-\d{8}T\d{6}\.qcow2$/.test(file) || !existsSync(path)) return false;
    if (Object.values(index.layers ?? {}).some((layer) => layer.file === file) || usedDisks().has(path)) return false;
    rmSync(path);
    return true;
  });
  const logTail = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n|\r/).filter((line) => line.trim()).slice(-30).join("\n");

  // Builds image key by adding its one missing component on top of the image parent.
  const buildLayer = async (key: string, parent: string, refresh: boolean): Promise<Layer | null> => {
    const dir = imageDir(release);
    const id = digest(key);
    const timeout = seconds(flags.timeout, 1800);
    return withLock(join(dir, `build-${id}.lock`), timeout, async () => {
      if (!refresh && layerState(readIndex(release), key) === "ready") return null;
      const parentNames = parent === UPSTREAM ? [] : parent.split("+");
      const component = components.get(key.split("+").find((name) => !parentNames.includes(name))!)!;
      const parentFile = fileOf(readIndex(release), parent)!;
      const parentPath = join(dir, parentFile);
      const work = join(dir, `build-${id}-${stamp()}`);
      mkdirSync(work, { mode: 0o700 });
      writeFileSync(join(work, "IMAGE"), `${key}\n`);
      const size = Math.max(parseSize(component.disk, "disk"), virtualSize(parentPath));
      run(["qemu-img", "create", "-q", "-f", "qcow2", "-b", parentPath, "-F", "qcow2", join(work, "disk.qcow2"), String(size)]);
      run(["tar", "-C", component.dir, "--owner=0", "--group=0", "-cf", join(work, "component.tar"), "."]);
      makeSeed(work, cloudConfig({
        users: [], disable_root: true, ssh_pwauth: false,
        write_files: [{ path: "/root/testvm-build.sh", permissions: "0700", content: buildRunner(release, component.name, key) }],
        runcmd: [["bash", "-c",
          "if /root/testvm-build.sh >/dev/ttyS1 2>&1; then echo TESTVM_BUILD_OK >/dev/ttyS1; else echo TESTVM_BUILD_FAILED >/dev/ttyS1; fi; rm -f /root/testvm-build.sh; sync; systemctl poweroff --no-block"]],
      }), { "instance-id": basename(work), "local-hostname": "testvm-build" }, ["component.tar"]);
      const buildLog = join(work, "build.log");
      log(`building ${key}: ${parent} + ${component.source} component ${component.name} (${release}); build log: ${buildLog}`);
      const vm = Bun.spawn({
        cmd: qemuArgs(work, { ...component.build, netdev: "user,id=net0", daemonize: false, buildLog }),
        stdin: "ignore", stdout: "ignore", stderr: "pipe",
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([vm.exited.then(() => true),
        new Promise<false>((done) => { timer = setTimeout(() => done(false), timeout); })]);
      clearTimeout(timer);
      if (!finished) { vm.kill(); await vm.exited; fail(`Build of ${key} timed out; diagnostics kept in ${work}. Last build.log lines:\n${logTail(buildLog)}`); }
      const output = existsSync(buildLog) ? readFileSync(buildLog, "utf8") : "";
      if (!/^TESTVM_BUILD_OK\r?$/m.test(output)) {
        const stderr = (await new Response(vm.stderr).text()).trim();
        fail(`Build of ${key} failed${stderr ? `: ${stderr}` : ""}; diagnostics kept in ${work}. Last build.log lines:\n${logTail(buildLog)}`);
      }
      const lower = readIndex(release).layers?.[parent];
      const versions: Record<string, string> = { ...lower?.versions };
      for (const [, line] of output.matchAll(/^TESTVM_VERSIONS (.+?)\r?$/gm)) {
        for (const pair of line.split(" ").filter((item) => item.includes("="))) {
          const [name, ...value] = pair.split("=");
          versions[name] = value.join("=");
        }
      }
      const file = `layer-${id}-${basename(work).slice(-15)}.qcow2`;
      run(["qemu-img", "convert", "-O", "qcow2", join(work, "disk.qcow2"), join(dir, `.${file}.tmp`)]);
      chmodSync(join(dir, `.${file}.tmp`), 0o444);
      renameSync(join(dir, `.${file}.tmp`), join(dir, file));
      const layer: Layer = {
        file, at: new Date().toISOString(), component: component.name, parent, parentFile, defHash: component.hash,
        groups: [...new Set([...(lower?.groups ?? []), ...component.groups])], versions,
      };
      const previous = readIndex(release).layers?.[key]?.file;
      await updateIndex(release, (index) => { index.layers = { ...index.layers, [key]: layer }; });
      rmSync(work, { recursive: true });
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith(`build-${id}-`)) rmSync(join(dir, entry), { recursive: true, force: true });
      }
      if (previous) await reclaim(release, previous);
      return layer;
    });
  };
  // Makes image key ready: starts from the largest ready image whose components are a subset of it
  // (nothing with refresh) and adds the remaining components one layer at a time; returns the built keys.
  const ensureImage = async (key: string, refresh = false) => {
    if (key === UPSTREAM) return [];
    requireRuntime();
    const index = readIndex(release);
    if (!index.upstream) fail(`No upstream image for ${release}; run image fetch first`);
    if (!refresh && layerState(index, key) === "ready") return [];
    const target = key.split("+");
    const base = refresh ? [] : Object.keys(index.layers ?? {})
      .filter((candidate) => candidate !== key && layerState(index, candidate) === "ready"
        && candidate.split("+").every((name) => target.includes(name)))
      .sort((a, b) => b.split("+").length - a.split("+").length || a.localeCompare(b))[0]?.split("+") ?? [];
    const built: string[] = [];
    const have = [...base];
    for (const name of orderComponents(target.filter((item) => !base.includes(item)), base)) {
      const parent = keyOf(have);
      have.push(name);
      const next = keyOf(have);
      if (!refresh && next !== key && layerState(readIndex(release), next) === "ready") continue;
      if (await buildLayer(next, parent, refresh)) built.push(next);
    }
    return built;
  };

  // SSH identity owned by the store; it lets the CLI reach every VM without the password.
  const keyPath = join(root, "ssh", "id_ed25519");
  const ensureKey = () => {
    if (existsSync(keyPath)) return;
    mkdirSync(join(root, "ssh"), { recursive: true, mode: 0o700 });
    run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "debian-testvm", "-f", keyPath]);
  };
  const connectHost = (vm: Instance) => (vm.bind === "0.0.0.0" || vm.bind === "::" ? "127.0.0.1" : vm.bind);
  const sshOptions = [
    "-i", keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR",
  ];
  const sshTarget = (vm: Instance) => `${vm.user}@${connectHost(vm)}`;
  const describe = (vm: Instance) => {
    const dir = instanceDir(vm.name);
    const index = readIndex(vm.release);
    const layer = index.layers?.[vm.image];
    const current = fileOf(index, vm.image);
    return {
      name: vm.name, status: vmPid(dir) ? "running" : "stopped", image: vm.image, release: vm.release,
      url: `ssh://${vm.user}@${connectHost(vm)}:${vm.port}`, host: connectHost(vm), port: vm.port,
      user: vm.user, password: vm.password, ssh: `ssh -p ${vm.port} ${sshTarget(vm)}`,
      cli: `bun ${import.meta.path} ssh --name ${vm.name}`,
      versions: layer && join(imageDir(vm.release), layer.file) === vm.imagePath ? layer.versions : null,
      image_outdated: !current || join(imageDir(vm.release), current) !== vm.imagePath,
      purpose: vm.purpose ?? null, owner: vm.owner ?? null, release_when: vm.releaseWhen ?? null,
      created_at: vm.createdAt, dir, serial_log: join(dir, "serial.log"),
    };
  };

  if (command === "image new") {
    const name = validComponentName(args[0]);
    const requires = flags.requires ? flags.requires.split(/[,+]/).filter(Boolean) : [];
    for (const dependency of requires) expand(dependency);
    const dir = join(userComponents, name);
    if (existsSync(dir)) fail(`${dir} already exists`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "image.json"), `${JSON.stringify({ requires, description: "", groups: [] }, null, 2)}\n`);
    writeFileSync(join(dir, "provision.sh"), PROVISION_TEMPLATE);
    emit({ component: name, requires, definition: dir, overrides_builtin: components.get(name)?.source === "builtin" });
    return;
  }

  if (command === "image fetch") {
    const dir = imageDir(release);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const source = `https://cloud.debian.org/images/cloud/${release}/latest`;
    const sums = run(["curl", "-fsSL", "--retry", "3", `${source}/SHA512SUMS`]);
    const match = /^([0-9a-f]{128})\s+(debian-\d+-genericcloud-amd64\.qcow2)$/m.exec(sums)
      ?? fail(`No genericcloud amd64 image listed in ${source}/SHA512SUMS`);
    const [, sum, remoteName] = match;
    const file = `upstream-${sum.slice(0, 16)}.qcow2`;
    const current = readIndex(release).upstream;
    if (current?.sha512 === sum && existsSync(join(dir, file))) {
      emit({ release, upstream: current, changed: false });
      return;
    }
    const temp = join(dir, `.download-${randomUUID()}`);
    log(`downloading ${source}/${remoteName}`);
    try {
      const download = Bun.spawnSync({
        cmd: ["curl", "-fL", "--retry", "3", "--progress-bar", "-o", temp, `${source}/${remoteName}`],
        stdin: "ignore", stdout: "ignore", stderr: "inherit",
      });
      if (download.exitCode !== 0) fail(`Download failed (curl exit ${download.exitCode})`);
      if (await sha512(temp) !== sum) fail(`Checksum mismatch for ${remoteName}`);
      chmodSync(temp, 0o444);
      renameSync(temp, join(dir, file));
    } finally {
      rmSync(temp, { force: true });
    }
    const upstream = { file, at: new Date().toISOString(), source: `${source}/${remoteName}`, sha512: sum };
    await updateIndex(release, (index) => { index.upstream = upstream; });
    emit({ release, upstream, changed: true });
    return;
  }

  if (command === "image build") {
    const key = expand(args[0]);
    if (key === UPSTREAM) fail(`"${UPSTREAM}" is fetched, not built; use image fetch`);
    const built = await ensureImage(key, flags.refresh ?? false);
    emit({ release, image: key, built, layer: readIndex(release).layers?.[key] });
    return;
  }

  if (command === "image ls") {
    const index = readIndex(release);
    emit({
      release, user_components: userComponents,
      components: [...components.values()].sort((a, b) => a.name.localeCompare(b.name)).map((component) => ({
        name: component.name, source: component.source, requires: component.requires,
        description: component.description, definition: component.dir,
      })),
      images: [
        { image: UPSTREAM, state: layerState(index, UPSTREAM), file: index.upstream?.file ?? null, built_at: index.upstream?.at ?? null, versions: null },
        ...Object.keys(index.layers ?? {}).sort().map((key) => ({
          image: key, state: layerState(index, key), built_on: index.layers![key].parent ?? null, file: index.layers![key].file,
          built_at: index.layers![key].at, versions: index.layers![key].versions,
        })),
      ],
      failed_builds: existsSync(imageDir(release))
        ? readdirSync(imageDir(release)).filter((file) => file.startsWith("build-") && !file.endsWith(".lock")) : [],
    });
    return;
  }

  if (command === "image rm" || command === "image prune") {
    const used = usedDisks();
    const target = command !== "image rm" ? null : (() => {
      try { return expand(args[0]); } catch { return args[0].split("+").map(validComponentName).sort().join("+"); }
    })();
    const result = await withLock(storeLock, 60_000, async () => {
      const removed: string[] = [];
      const kept: string[] = [];
      const releases = target ? [release] : readdirSync(join(root, "images")).filter((name) => existsSync(indexPath(name)));
      for (const name of releases) {
        const dir = imageDir(name);
        const index = readIndex(name);
        const layers = { ...index.layers };
        let candidates: string[];
        if (target) {
          // Layers are flattened, so removing one never breaks the disks built on top of it.
          const failed = existsSync(dir) ? readdirSync(dir).filter((file) => file.startsWith(`build-${digest(target)}-`)) : [];
          candidates = existsSync(dir) ? readdirSync(dir).filter((file) => new RegExp(`^layer-${digest(target)}-\\d{8}T\\d{6}\\.qcow2$`).test(file)) : [];
          if (!layers[target] && !failed.length && !candidates.length) fail(`Nothing built or failed for ${target} in ${name}; image ls lists images`);
          delete layers[target];
          for (const entry of failed) {
            rmSync(join(dir, entry), { recursive: true, force: true });
            removed.push(`${name}/${entry}`);
          }
        } else {
          for (const key of Object.keys(layers)) {
            if (key.split("+").some((component) => !components.has(component))) delete layers[key];
          }
          const current = new Set([index.upstream?.file, ...Object.values(layers).map((layer) => layer.file)]);
          candidates = readdirSync(dir).filter((file) => file.endsWith(".qcow2") && !current.has(file));
        }
        for (const file of candidates) {
          if (used.has(join(dir, file))) { kept.push(`${name}/${file}`); continue; }
          rmSync(join(dir, file));
          removed.push(`${name}/${file}`);
        }
        if (existsSync(dir)) writeJson(indexPath(name), { ...index, layers });
      }
      return { removed, kept_in_use: kept };
    });
    emit(result);
    return;
  }

  if (command === "ls") {
    emit({ instances: instances().map((vm) => {
      const { password: _, ...visible } = describe(vm);
      return visible;
    }) });
    return;
  }

  const launch = async (vm: Instance, timeoutMs: number) => {
    const dir = instanceDir(vm.name);
    if (vmPid(dir)) return;
    if (!(await portFree(vm.bind, vm.port))) fail(`Port ${vm.bind}:${vm.port} is in use`);
    rmSync(join(dir, "serial.log"), { force: true });
    run(qemuArgs(dir, {
      cpus: vm.cpus, memory: vm.memory, daemonize: true,
      netdev: `user,id=net0,hostname=${vm.name},hostfwd=tcp:${vm.bind}:${vm.port}-:22`,
    }));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!vmPid(dir)) fail(`QEMU exited during boot; see ${join(dir, "serial.log")}`);
      const probe = Bun.spawnSync({
        cmd: ["ssh", ...sshOptions, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-p", String(vm.port), sshTarget(vm),
          "cloud-init status --wait >/dev/null; cloud-init status"],
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const status = probe.stdout.toString();
      if (/status: done/.test(status)) return;
      if (/status: (error|degraded)/.test(status)) {
        fail(`cloud-init reported ${status.trim()}; instance kept for diagnosis (bun ${import.meta.path} ssh --name ${vm.name} -- sudo cloud-init status --long)`);
      }
      await sleep(2000);
    }
    fail(`VM not ready within ${timeoutMs / 1000}s; instance kept for diagnosis, serial log: ${join(dir, "serial.log")}`);
  };

  const provisionDisk = (vm: Instance) => {
    const dir = instanceDir(vm.name);
    if (!existsSync(vm.imagePath)) fail(`Image ${vm.imagePath} no longer exists`);
    rmSync(join(dir, "disk.qcow2"), { force: true });
    run(["qemu-img", "create", "-q", "-f", "qcow2", "-b", vm.imagePath, "-F", "qcow2", join(dir, "disk.qcow2"), vm.disk]);
    const keys = [readFileSync(`${keyPath}.pub`, "utf8").trim()];
    const keyFiles = config.authorizedKeyFiles
      ?? ["id_ed25519.pub", "id_rsa.pub"].map((file) => join(homedir(), ".ssh", file)).filter(existsSync);
    for (const file of keyFiles) keys.push(readFileSync(file.replace(/^~(?=\/)/, homedir()), "utf8").trim());
    // Official images ship the locales package without generated locales; cc_locale needs the target generated first.
    const charset = vm.locale.split(".")[1] ?? "UTF-8";
    const genLocale = /^C(\.|$)/.test(vm.locale) ? [] : [["sh", "-c",
      `locale -a | grep -qix '${vm.locale.replace(/UTF-8$/i, "utf8")}' || { sed -i 's/^# *${vm.locale} ${charset}$/${vm.locale} ${charset}/' /etc/locale.gen; grep -qx '${vm.locale} ${charset}' /etc/locale.gen || echo '${vm.locale} ${charset}' >> /etc/locale.gen; locale-gen; }`]];
    makeSeed(dir, cloudConfig({
      hostname: vm.name, locale: vm.locale, timezone: vm.timezone, ssh_pwauth: true, bootcmd: genLocale,
      users: [{
        name: vm.user, gecos: "Test VM user", shell: "/bin/bash", sudo: "ALL=(ALL) NOPASSWD:ALL",
        groups: ["sudo", ...vm.groups], lock_passwd: false, plain_text_passwd: vm.password, ssh_authorized_keys: keys,
      }],
    }), { "instance-id": vm.instanceId, "local-hostname": vm.name });
  };

  if (command === "up") {
    const purpose = required(flags.purpose, "purpose");
    const releaseWhen = required(flags["release-when"], "release-when");
    requireRuntime();
    ensureKey();
    const image = expand(flags.image ?? config.defaultImage ?? DEFAULT_IMAGE);
    if (!readIndex(release).upstream) fail(`No upstream image for ${release}; run image fetch`);
    const built = await ensureImage(image);
    const index = readIndex(release);
    const imagePath = join(imageDir(release), fileOf(index, image)!);
    const groups = image === UPSTREAM ? [] : index.layers![image].groups;
    const disk = flags.disk ?? config.disk ?? "20G";
    const minimum = virtualSize(imagePath);
    if (parseSize(disk, "--disk") < minimum) fail(`--disk must be at least the image size (${Math.ceil(minimum / 1024 ** 3)}G)`);
    const bind = flags.bind ?? config.bind ?? "127.0.0.1";
    const password = process.env.TESTVM_PASSWORD ?? config.password ?? randomBytes(12).toString("base64url");
    const vm = await withLock(storeLock, 60_000, async () => {
      const name = validName(flags.name ?? `t-${randomBytes(3).toString("hex")}`);
      if (existsSync(instanceDir(name))) fail(`Instance ${name} already exists`);
      const taken = new Set(instances().map((item) => item.port));
      let port = flags.port ? positiveInt(flags.port, "--port", 0) : 0;
      if (port && (taken.has(port) || !(await portFree(bind, port)))) fail(`Port ${port} is in use`);
      for (let candidate = PORT_RANGE[0]; !port && candidate <= PORT_RANGE[1]; candidate += 1) {
        if (!taken.has(candidate) && await portFree(bind, candidate)) port = candidate;
      }
      if (!port) fail("No free port in 22000-22999");
      const vm: Instance = {
        name, release, image, imagePath, groups, instanceId: `${name}-${randomUUID()}`,
        user: config.user ?? "dev", password, bind, port,
        cpus: positiveInt(flags.cpus ?? config.cpus, "--cpus", 2), memory: positiveInt(flags.memory ?? config.memory, "--memory", 2048),
        disk, locale: validLocale(config.locale ?? "en_US.UTF-8"), timezone: config.timezone ?? "Etc/UTC",
        purpose, owner: flags.owner, releaseWhen, createdAt: new Date().toISOString(),
      };
      mkdirSync(instanceDir(name), { mode: 0o700 });
      writeJson(join(instanceDir(name), "instance.json"), vm);
      return vm;
    });
    await withLock(join(instanceDir(vm.name), "op.lock"), 0, async () => {
      provisionDisk(vm);
      log(`booting ${vm.name} (${image}, ${release}) on ${vm.bind}:${vm.port}`);
      await launch(vm, seconds(flags.timeout, 300));
    });
    emit({ ...describe(vm), built_layers: built });
    return;
  }

  const name = validName(required(flags.name, "name"));
  const dir = instanceDir(name);
  if (!existsSync(join(dir, "instance.json"))) fail(`Instance ${name} not found`);
  const vm = readJson<Instance>(join(dir, "instance.json"));

  if (command === "status") { emit(describe(vm)); return; }

  if (command === "ssh" || command === "cp") {
    if (!vmPid(dir)) fail(`Instance ${name} is not running; start it first`);
    let cmd: string[];
    if (command === "ssh") {
      cmd = ["ssh", ...sshOptions, ...(remote.length ? [] : ["-t"]), "-p", String(vm.port), sshTarget(vm), ...remote];
    } else {
      if (args.length < 2) fail("cp needs SOURCE... DEST");
      const remoteFlags = args.map((path) => path.startsWith(":"));
      const toVm = remoteFlags.at(-1);
      if (remoteFlags.slice(0, -1).some((flag) => flag === toVm)) fail("cp copies either local→VM or VM→local; prefix the VM side with ':'");
      cmd = ["scp", ...sshOptions, "-r", "-P", String(vm.port),
        ...args.map((path) => (path.startsWith(":") ? `${sshTarget(vm)}:${path.slice(1)}` : path))];
    }
    const child = Bun.spawn({ cmd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exitCode = await child.exited;
    return;
  }

  await withLock(join(dir, "op.lock"), 0, async () => {
    if (command === "start") {
      requireRuntime();
      await launch(vm, seconds(flags.timeout, 300));
      emit(describe(vm));
    } else if (command === "annotate") {
      if (!flags.owner && !flags.purpose && !flags["release-when"]) fail("annotate needs --owner, --purpose or --release-when");
      const next = { ...vm, owner: flags.owner ?? vm.owner, purpose: flags.purpose ?? vm.purpose, releaseWhen: flags["release-when"] ?? vm.releaseWhen };
      writeJson(join(dir, "instance.json"), next);
      const { password: _, ...visible } = describe(next);
      emit(visible);
    } else if (command === "stop") {
      emit({ name, result: await stopVm(dir) });
    } else if (command === "reset") {
      requireRuntime();
      await stopVm(dir);
      const next = { ...vm, instanceId: `${name}-${randomUUID()}` };
      provisionDisk(next);
      writeJson(join(dir, "instance.json"), next);
      log(`rebooting ${name} from a fresh disk`);
      await launch(next, seconds(flags.timeout, 300));
      emit(describe(next));
    } else if (command === "rm") {
      const result = await stopVm(dir);
      rmSync(dir, { recursive: true });
      const reclaimed = vm.imagePath && await reclaim(vm.release, basename(vm.imagePath)) ? basename(vm.imagePath) : null;
      emit({ removed: name, vm: result, reclaimed_image: reclaimed });
    }
  });
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
