import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runtimeReport, type RuntimeFacts } from "../scripts/lib/host-runtime.ts";

const ready: RuntimeFacts = {
  platform: "linux", arch: "x64", cpuVirtualization: "vmx", hypervisor: "vmware",
  kvmDevice: true, kvmAccess: true, configuredKvmGroup: false, activeKvmGroup: false,
  tools: { "qemu-system-x86_64": "/bin/qemu-system-x86_64", "qemu-img": "/bin/qemu-img",
    ssh: "/bin/ssh", scp: "/bin/scp", "ssh-keygen": "/bin/ssh-keygen", curl: "/bin/curl", tar: "/bin/tar" },
  iso: "/bin/xorriso",
};

test("VMware without CPU extensions explains host-side nested virtualization", () => {
  const report = runtimeReport({ ...ready, cpuVirtualization: null, kvmDevice: false, kvmAccess: false });
  expect(report.ok).toBe(false);
  expect(report.problems.join("; ")).toContain("Virtualize Intel VT-x/EPT or AMD-V/RVI");
  expect(report.problems.join("; ")).toContain("power off");
});

test("exposed Intel and AMD extensions with no device point to their kernel modules", () => {
  for (const [cpuVirtualization, module] of [["vmx", "kvm_intel"], ["svm", "kvm_amd"]] as const) {
    const report = runtimeReport({ ...ready, cpuVirtualization, kvmDevice: false, kvmAccess: false });
    expect(report.ok).toBe(false);
    expect(report.problems.join("; ")).toContain(module);
  }
});

test("device access through ACL works without kvm group membership", () => {
  expect(runtimeReport(ready).ok).toBe(true);
  const stale = runtimeReport({ ...ready, kvmAccess: false, configuredKvmGroup: true });
  expect(stale.problems.join("; ")).toContain("new login session");
  const denied = runtimeReport({ ...ready, kvmAccess: false, configuredKvmGroup: true, activeKvmGroup: true });
  expect(denied.problems.join("; ")).toContain("permissions or ACL");
});

test("unknown CPU flags do not invent a passthrough failure, while unsupported hosts fail clearly", () => {
  expect(runtimeReport({ ...ready, cpuVirtualization: undefined }).ok).toBe(true);
  const unsupported = runtimeReport({ ...ready, platform: "darwin", arch: "arm64", kvmDevice: false, kvmAccess: false });
  expect(unsupported.ok).toBe(false);
  expect(unsupported.problems).toEqual(["Linux x86_64 host required"]);
  const hidden = runtimeReport({ ...ready, cpuVirtualization: null });
  expect(hidden.ok).toBe(false);
  expect(hidden.problems.join("; ")).toContain("vmx/svm");
});

test("missing tools include the Debian package remedy separately from KVM", () => {
  const report = runtimeReport({ ...ready, tools: { ...ready.tools, "qemu-img": null }, iso: null });
  expect(report.ok).toBe(false);
  expect(report.kvm).toBe(true);
  expect(report.problems.join("; ")).toContain("qemu-img not found");
  expect(report.problems.join("; ")).toContain("qemu-system-x86 qemu-utils xorriso");
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("doctor fails without tools and never creates a store or configuration", () => {
  const scratch = mkdtempSync(join(tmpdir(), "testvm-doctor-")); roots.push(scratch);
  const root = join(scratch, "store"), config = join(scratch, "config");
  const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../scripts/testvm.ts"),
    "doctor", "--root", root, "--config", config], { env: { ...process.env, PATH: join(scratch, "missing-bin") } });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString()).tools["qemu-img"]).toBe(null);
  expect(existsSync(root)).toBe(false);
  expect(existsSync(config)).toBe(false);
});
