import { accessSync, constants, readFileSync } from "node:fs";
import { userInfo } from "node:os";

const requiredTools = ["qemu-system-x86_64", "qemu-img", "ssh", "scp", "ssh-keygen", "curl", "tar"] as const;

export type RuntimeFacts = {
  platform: string; arch: string;
  cpuVirtualization: "vmx" | "svm" | null | undefined;
  hypervisor: string | null;
  kvmDevice: boolean; kvmAccess: boolean;
  configuredKvmGroup: boolean; activeKvmGroup: boolean;
  tools: Record<typeof requiredTools[number], string | null>;
  iso: string | null;
};

function readHostFile(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); } catch (error) {
    if (["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

function canAccessKvm(mode: number): boolean {
  try { accessSync("/dev/kvm", mode); return true; } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

export function runtimeReport(facts: RuntimeFacts) {
  const problems: string[] = [];
  if (facts.platform !== "linux" || facts.arch !== "x64") {
    problems.push("Linux x86_64 host required");
  } else {
    if (facts.cpuVirtualization === null) {
      problems.push(facts.hypervisor === "vmware"
        ? "CPU has no vmx/svm flags: power off this VM, then enable VMware Processors > Virtualize Intel VT-x/EPT or AMD-V/RVI on the outer host; a host Hyper-V/VBS conflict must be resolved there"
        : facts.hypervisor
          ? "CPU has no vmx/svm flags: enable nested virtualization on the outer host and expose Intel VT-x/AMD-V to this guest"
          : "CPU has no vmx/svm flags: check Intel VT-x/AMD-V in BIOS/UEFI, or enable nested virtualization on the outer host if this is a guest");
    }
    if (!facts.kvmDevice) {
      const module = facts.cpuVirtualization === "vmx" ? "kvm_intel" : facts.cpuVirtualization === "svm" ? "kvm_amd" : null;
      problems.push(module
        ? `/dev/kvm is missing despite exposed CPU virtualization: check the host kernel's ${module} module and udev; after authorization try sudo modprobe ${module}`
        : "/dev/kvm is missing; verify CPU virtualization passthrough, then KVM kernel support and udev");
    } else if (!facts.kvmAccess) {
      problems.push(facts.configuredKvmGroup && !facts.activeKvmGroup
        ? "kvm group membership is not active in this login; start a new login session (WSL: wsl --shutdown)"
        : facts.activeKvmGroup
          ? "no read/write access to /dev/kvm despite active kvm membership; inspect device permissions or ACL and udev rules"
          : "no read/write access to /dev/kvm; inspect device permissions or ACL; after authorization add the user to the kvm group and start a new login session");
    }
  }
  for (const [tool, path] of Object.entries(facts.tools)) if (!path) problems.push(`${tool} not found`);
  if (!facts.iso) problems.push("genisoimage or xorriso not found");
  if (Object.values(facts.tools).some((path) => !path) || !facts.iso) {
    problems.push("On Debian, install missing tools after authorization: sudo apt-get install --no-install-recommends qemu-system-x86 qemu-utils xorriso openssh-client curl tar");
  }
  return { ok: problems.length === 0, kvm: facts.kvmAccess,
    cpu_virtualization: facts.cpuVirtualization ?? null, hypervisor: facts.hypervisor,
    tools: { ...facts.tools, iso: facts.iso }, problems };
}

export function doctor() {
  const flags = readHostFile("/proc/cpuinfo")?.match(/^flags\s*:\s*(.*)$/m)?.[1];
  const cpuVirtualization = flags === undefined ? undefined
    : /\bvmx\b/.test(flags) ? "vmx" : /\bsvm\b/.test(flags) ? "svm" : null;
  const vendor = readHostFile("/sys/class/dmi/id/sys_vendor")?.trim();
  const kernel = readHostFile("/proc/sys/kernel/osrelease");
  const hypervisor = vendor?.includes("VMware") ? "vmware"
    : /microsoft|wsl/i.test(kernel ?? "") ? "wsl"
      : /\bhypervisor\b/.test(flags ?? "") ? "virtual-machine" : null;
  const group = readHostFile("/etc/group")?.split("\n").find((line) => line.startsWith("kvm:"))?.split(":");
  const configuredKvmGroup = group?.[3]?.split(",").includes(userInfo().username) ?? false;
  const activeKvmGroup = !!group && ((process.getgroups?.().includes(Number(group[2])) || process.getgid?.() === Number(group[2])) ?? false);
  return runtimeReport({
    platform: process.platform, arch: process.arch, cpuVirtualization, hypervisor,
    kvmDevice: canAccessKvm(constants.F_OK), kvmAccess: canAccessKvm(constants.R_OK | constants.W_OK),
    configuredKvmGroup, activeKvmGroup,
    tools: Object.fromEntries(requiredTools.map((tool) => [tool, Bun.which(tool) ?? null])) as RuntimeFacts["tools"],
    iso: Bun.which("genisoimage") ?? Bun.which("xorriso") ?? null,
  });
}
