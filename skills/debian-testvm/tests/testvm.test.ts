import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

setDefaultTimeout(900_000);
const cli = resolve(import.meta.dir, "../scripts/testvm.ts");
const root = process.env.TESTVM_TEST_ROOT ?? join(homedir(), ".local/share/debian-testvm");
const password = `T-${randomBytes(9).toString("base64url")}`;
const createdVms: string[] = [];
const createdImages: string[] = [];
let scratch: string;
let configDir: string;

function call(...args: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, cli, "--root", root, "--config", configDir, ...args],
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
}
function ok(...args: string[]): any {
  const result = call(...args);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return JSON.parse(result.stdout.toString());
}
function remote(name: string, script: string) {
  const result = call("ssh", "--name", name, "--", script);
  return { code: result.exitCode, out: result.stdout.toString().trim() };
}
function up(...args: string[]) {
  const name = `tvm-test-${randomBytes(3).toString("hex")}`;
  createdVms.push(name);
  return ok("up", "--name", name, "--purpose", "debian-testvm lifecycle test", "--release-when", "test teardown",
    "--owner", "debian-testvm tests", "--memory", "1536", ...args);
}
// Logs in with the delivered password only, as a human or another tool would.
function passwordLogin(vm: any, script: string) {
  const askpass = join(scratch, "askpass");
  writeFileSync(askpass, `#!/bin/sh\nprintf '%s\\n' "$TESTVM_TEST_PASSWORD"\n`, { mode: 0o700 });
  const result = Bun.spawnSync({
    cmd: ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR",
      "-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password", "-o", "NumberOfPasswordPrompts=1",
      "-p", String(vm.port), `${vm.user}@${vm.host}`, script],
    env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0", TESTVM_TEST_PASSWORD: vm.password },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}
function state(image: string) {
  return ok("image", "ls").images.find((item: any) => item.image === image)?.state;
}
function layerFile(image: string) {
  return JSON.parse(readFileSync(join(root, "images/trixie/index.json"), "utf8")).layers[image].file as string;
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "testvm-test-"));
  configDir = join(scratch, "config");
  mkdirSync(configDir);
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ password, timezone: "America/New_York", authorizedKeyFiles: [] }), { mode: 0o600 });
});

afterAll(() => {
  for (const name of createdVms) if (existsSync(join(root, "instances", name))) call("rm", "--name", name);
  for (const image of createdImages.reverse()) call("image", "rm", image);
  rmSync(scratch, { recursive: true, force: true });
});

test("default docker image delivers a password login with Docker, Compose and Git, and reset restores a clean disk", () => {
  const vm = up();
  expect(vm).toMatchObject({ status: "running", image: "docker", user: "dev", password, host: "127.0.0.1" });
  expect(vm.url).toBe(`ssh://dev@127.0.0.1:${vm.port}`);

  const facts = passwordLogin(vm, "id -nG; sudo -n true && echo sudo-ok; docker info --format '{{.ServerVersion}}'; docker compose version --short; git --version; locale | grep '^LANG='; cat /etc/timezone");
  expect(facts).toContain("docker");
  expect(facts).toContain("sudo-ok");
  expect(facts).toMatch(/^\d+\.\d+\.\d+$/m);
  expect(facts).toContain("git version");
  expect(facts).toContain("LANG=en_US.UTF-8");
  expect(facts).toContain("America/New_York");

  const local = join(scratch, "payload.txt");
  writeFileSync(local, "payload\n");
  expect(call("cp", "--name", vm.name, local, ":/home/dev/").exitCode).toBe(0);
  expect(remote(vm.name, "cat ~/payload.txt").out).toBe("payload");
  expect(remote(vm.name, "exit 7").code).toBe(7);

  const reset = ok("reset", "--name", vm.name);
  expect(reset).toMatchObject({ status: "running", port: vm.port, password });
  expect(remote(vm.name, "test -e ~/payload.txt").code).not.toBe(0);
  expect(passwordLogin(reset, "docker compose version --short")).toMatch(/^\d+\.\d+\.\d+$/);

  expect(ok("rm", "--name", vm.name).removed).toBe(vm.name);
  expect(existsSync(join(root, "instances", vm.name))).toBe(false);
});

test("debian image is the unmodified official image", () => {
  const vm = up("--image", "debian");
  expect(vm.image).toBe("debian");
  expect(passwordLogin(vm, "grep -o '^[0-9]*' /etc/debian_version; command -v docker || echo no-docker")).toMatch(/^\d+\nno-docker$/);
  expect(ok("rm", "--name", vm.name).removed).toBe(vm.name);
});

test("user components compose in requires order, cache each layer and rebuild only what changed", () => {
  const suffix = randomBytes(3).toString("hex");
  const a = `tvmt-a-${suffix}`;
  const b = `tvmt-b-${suffix}`;
  createdImages.push(a, `${a}+${b}`, `docker+${a}`, `docker+${a}+${b}`);
  const newA = ok("image", "new", a);
  expect(newA.definition).toBe(join(configDir, "images", a));
  writeFileSync(join(newA.definition, "image.json"), JSON.stringify({ groups: ["tvmta"] }));
  writeFileSync(join(newA.definition, "marker.txt"), "from-a\n");
  writeFileSync(join(newA.definition, "provision.sh"),
    "groupadd tvmta\ninstall -m 0644 marker.txt /etc/testvm-a\necho \"TESTVM_VERSIONS a=1.0\"\n");
  const newB = ok("image", "new", b, "--requires", a);
  writeFileSync(join(newB.definition, "provision.sh"),
    "test -f /etc/testvm-a\necho \"after-a ${TESTVM_IMAGE}\" > /etc/testvm-b\necho \"TESTVM_VERSIONS b=2.0\"\n");

  const vm = up("--image", b);
  expect(vm.image).toBe(`${a}+${b}`);
  expect(vm.built_layers).toEqual([a, `${a}+${b}`]);
  expect(vm.versions).toMatchObject({ a: "1.0", b: "2.0" });
  const facts = passwordLogin(vm, "cat /etc/testvm-a /etc/testvm-b; id -nG; command -v docker || echo no-docker");
  expect(facts).toBe(`from-a\nafter-a ${a}+${b}\ndev sudo tvmta\nno-docker`);
  const annotated = ok("annotate", "--name", vm.name, "--release-when", "after the composition checks");
  expect(annotated).toMatchObject({ release_when: "after the composition checks", owner: "debian-testvm tests" });
  expect(annotated.password).toBeUndefined();

  const mixed = up("--image", `docker+${a}`);
  expect(mixed.built_layers).toEqual([`docker+${a}`]);
  expect(passwordLogin(mixed, "cat /etc/testvm-a; docker compose version --short; id -nG"))
    .toMatch(new RegExp(`^from-a\\n\\d+\\.\\d+\\.\\d+\\ndev sudo docker tvmta$`));
  // Written order does not matter without requires: a+docker is the cached docker+a.
  expect(ok("image", "build", `${a}+docker`)).toMatchObject({ image: `docker+${a}`, built: [] });
  // Reuse by subset: with a+b and docker+a built, docker+a+b only adds b on top of docker+a.
  const superset = ok("image", "build", `${b}+docker`);
  expect(superset).toMatchObject({ image: `docker+${a}+${b}`, built: [`docker+${a}+${b}`] });
  expect(superset.layer.parent).toBe(`docker+${a}`);

  appendFileSync(join(newB.definition, "provision.sh"), "echo changed > /etc/testvm-b-changed\n");
  expect(state(a)).toBe("ready");
  expect(state(`${a}+${b}`)).toBe("stale");
  const superseded = layerFile(`${a}+${b}`);
  expect(ok("image", "build", b).built).toEqual([`${a}+${b}`]);
  expect(state(`${a}+${b}`)).toBe("ready");
  // The superseded layer still backs vm, so it stays until that VM is removed, then goes automatically.
  expect(existsSync(join(root, "images/trixie", superseded))).toBe(true);
  expect(ok("rm", "--name", vm.name)).toMatchObject({ removed: vm.name, reclaimed_image: superseded });
  expect(existsSync(join(root, "images/trixie", superseded))).toBe(false);
  // A VM on a current layer leaves it in place.
  expect(ok("rm", "--name", mixed.name)).toMatchObject({ removed: mixed.name, reclaimed_image: null });
  for (const image of [`${a}+${b}`, `docker+${a}+${b}`, `docker+${a}`]) expect(ok("image", "rm", image).removed).toHaveLength(1);

  // A VM disk whose metadata this CLI cannot read (another version, another task) still protects its image.
  const aFile = layerFile(a);
  const foreign = join(root, "instances", `tvm-foreign-${suffix}`);
  mkdirSync(foreign);
  try {
    expect(Bun.spawnSync({ cmd: ["qemu-img", "create", "-q", "-f", "qcow2", "-F", "qcow2",
      "-b", join(root, "images/trixie", aFile), join(foreign, "disk.qcow2")] }).exitCode).toBe(0);
    expect(ok("image", "rm", a)).toMatchObject({ removed: [], kept_in_use: [`trixie/${aFile}`] });
    expect(existsSync(join(root, "images/trixie", aFile))).toBe(true);
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
  rmSync(join(root, "images/trixie", aFile));
});

test("a failed build reports its log tail, and fixing the component cleans the failure up", () => {
  const c = `tvmt-c-${randomBytes(3).toString("hex")}`;
  createdImages.push(c);
  const { definition } = ok("image", "new", c);
  writeFileSync(join(definition, "provision.sh"), "echo provisioning-step-marker\nexit 3\n");
  const failed = call("image", "build", c);
  expect(failed.exitCode).toBe(1);
  const error = JSON.parse(failed.stderr.toString().trim().split("\n").at(-1)!).error as string;
  expect(error).toContain(`Build of ${c} failed`);
  expect(error).toContain("provisioning-step-marker");
  const failures = ok("image", "ls").failed_builds as string[];
  const marker = (entry: string) => join(root, "images/trixie", entry, "IMAGE");
  const ours = failures.filter((entry) => existsSync(marker(entry)) && readFileSync(marker(entry), "utf8").trim() === c);
  expect(ours).toHaveLength(1);
  expect(state(c)).toBeUndefined();

  writeFileSync(join(definition, "provision.sh"), "echo \"TESTVM_VERSIONS c=fixed\"\n");
  expect(ok("image", "build", c).layer.versions.c).toBe("fixed");
  expect(existsSync(join(root, "images/trixie", ours[0]))).toBe(false);
  expect(ok("image", "rm", c).removed).toHaveLength(1);
});
