---
name: debian-testvm
description: 在 Linux/WSL2 主机上用 QEMU/KVM 快速拉起干净的 Debian Stable 虚拟机，交付 SSH 地址、用户名和密码，用于验证安装、部署和运维脚本在全新系统上的可用性；镜像由可组合的组件按需叠加（内置 docker，用户可在配置目录自定义），也可使用未改动的官方镜像。
---

# Debian Test VM

Boot disposable Debian VMs from the official Debian cloud image to test scripts on a clean system. Images are composed from components on demand and cached as disk layers; each VM is a copy-on-write overlay of one image, so creating and resetting a VM takes seconds. Networking is QEMU user-mode NAT with one forwarded SSH port: no bridges, firewall rules or daemons on the host.

## Prepare once

Run the bundled CLI with Bun 1.3+. Requires a Linux x86_64 host with Intel VT-x or AMD-V exposed to the guest and read/write `/dev/kvm`, `qemu-system-x86_64`, `qemu-img`, `genisoimage` or `xorriso`, OpenSSH client, `tar` and `curl`. Verify these on VMware and WSL2 rather than assuming nested virtualization is enabled. This skill uses KVM acceleration; the CLI never installs system packages, changes groups or switches to software emulation. `doctor` reports what is missing without creating a store or configuration.

```bash
bun <skill-dir>/scripts/testvm.ts doctor
bun <skill-dir>/scripts/testvm.ts image fetch            # official genericcloud image, SHA512 verified
```

On Debian hosts, after confirmation: `sudo apt-get install --no-install-recommends qemu-system-x86 qemu-utils xorriso openssh-client curl tar`. Refresh apt package lists if the install reports stale indexes. Existing read/write access via an ACL is sufficient; only when access is denied and the device uses the `kvm` group, request permission for `sudo usermod -aG kvm "$USER"`, then start a new login session (WSL: `wsl --shutdown`). Installing packages, loading kernel modules and changing groups require authorization.

- No `vmx` / `svm` CPU flag: fix virtualization on the outer host. For VMware Workstation, fully power off this Debian VM, open **VM Settings → Hardware → Processors**, enable **Virtualize Intel VT-x/EPT or AMD-V/RVI**, then boot again. If VMware reports VT-x/EPT is unsupported, inspect the outer host's BIOS/UEFI and Hyper-V/VBS conflicts; do not disable Windows features automatically. See [VMware's troubleshooting article](https://knowledge.broadcom.com/external/article/389469/virtualized-intel-vtxept-not-supported-o.html).
- CPU flags present but `/dev/kvm` missing: inspect the guest kernel's `kvm_intel` (Intel) or `kvm_amd` (AMD) module and udev; after authorization, try `sudo modprobe <module>`. Installing QEMU alone does not expose CPU virtualization.
- Device present but inaccessible: check `id`, device permissions and ACLs. A configured group that is not active needs a new login; active membership with denied access needs a permission/udev fix. Do not change permissions when `doctor` already reports `kvm: true`.

After the host changes, rerun `doctor`. A successful report verifies CPU flags, device access and tool paths; a real `up` is still required to verify KVM initialization, boot and SSH.

`--release` selects a Debian codename (default `trixie`, the current stable). Every image and VM belongs to one release.

## Images and components

An image is `debian` (the unmodified official image) or components joined with `+`, such as `docker`, `docker+nodejs` or `nodejs`. A component is a directory holding `image.json`, `provision.sh` and any files the script needs. The skill ships `docker` (Docker CE, Buildx and Compose plugins, Git from Docker's apt repository). User components live in `~/.config/debian-testvm/images/<component>/`; a user component with a built-in name overrides it.

```bash
bun <skill-dir>/scripts/testvm.ts image new nodejs                     # scaffold a component
bun <skill-dir>/scripts/testvm.ts image new compose-app --requires docker
bun <skill-dir>/scripts/testvm.ts image ls                             # components and built images with state
bun <skill-dir>/scripts/testvm.ts image build docker+nodejs [--refresh]
```

```json
{ "requires": ["docker"], "description": "…", "groups": ["docker"], "disk": "10G", "build": { "cpus": 4, "memory": 4096 } }
```

All `image.json` keys are optional. `requires` components are applied first; `groups` are added to the login user (cumulative across layers); `disk` is the minimum build disk size. `provision.sh` runs as root in a one-off build VM with `bash -euxo pipefail` in the component directory, with `TESTVM_RELEASE`, `TESTVM_COMPONENT` and `TESTVM_IMAGE` set. Lower layers keep no apt lists, so start with `apt-get update`. Print `TESTVM_VERSIONS key=value ...` lines to record versions. Do not create login users or rely on network services from other layers at build time.

The written order does not matter: components are applied after their `requires`, otherwise by name, so `nodejs+docker` and `docker+nodejs` are the same image `docker+nodejs`. Declare `requires` whenever one component must run after another. Every built image is cached. A missing image is built on the largest ready image whose components are a subset of it, adding the remaining components one cached layer at a time: with `docker+pg-client` built, `docker+nodejs+pg-client` builds only the nodejs layer. Components without `requires` between them are treated as independent. An image becomes `stale` when its component files change or the image it was built on (`built_on` in `image ls`) changes; `image build`, and `up`, build missing and stale layers automatically. `--refresh` rebuilds every layer of the image for fresher packages. After each `provision.sh` the framework removes apt lists, cloud-init state, machine-id and SSH host keys, then stores a flattened read-only disk.

Layer disks are a rebuildable cache that the CLI reclaims itself: a rebuild deletes the superseded disk at once, or, while a VM still runs on it, when that VM is removed. No Agent decision is needed for that. `image rm <image>` deletes one composition's layer disks and failed build directories when the composition is no longer wanted; `image prune` is a store-wide fallback that deletes non-current disks and forgets images whose components were removed. All of them keep every disk a VM overlay still uses, including VMs whose metadata the CLI cannot read.

## Deliver a VM

```bash
bun <skill-dir>/scripts/testvm.ts up --purpose "<what is tested>" --release-when "<condition>" --owner "<task>"
bun <skill-dir>/scripts/testvm.ts up --image debian --name clean-1 --purpose "<…>" --release-when "<…>"
bun <skill-dir>/scripts/testvm.ts up --image docker+nodejs --purpose "<…>" --release-when "<…>"
```

`up` returns JSON only after SSH answers and cloud-init has finished. Hand these fields to the requester: `url` (`ssh://user@host:port`), `ssh`, `user`, `password`, `image`, plus `versions`. `built_layers` lists layers built for this request. `--purpose` and `--release-when` are required (see below); `--owner` names the responsible task or person. Options: `--image` (config `defaultImage`, else `docker`), `--name`, `--cpus` (2), `--memory` MiB (2048), `--disk` (20G), `--port`, `--bind`, `--timeout` seconds.

- The account has passwordless sudo and the image's groups (for example `docker`). Password and key login both work.
- SSH binds to `127.0.0.1` by default. On WSL2 mirrored networking Windows reaches it through `localhost`. Use `--bind 0.0.0.0` only when the user asks for LAN access.
- Choose `debian` when the script under test installs its own dependencies or must prove it works on a bare system. Choose the smallest composition that matches the target environment otherwise.

## Run tests inside

```bash
bun <skill-dir>/scripts/testvm.ts cp --name <vm> ./install.sh :/tmp/
bun <skill-dir>/scripts/testvm.ts ssh --name <vm> -- 'bash /tmp/install.sh'
bun <skill-dir>/scripts/testvm.ts cp --name <vm> :/var/log/app.log ./evidence/
bun <skill-dir>/scripts/testvm.ts reset --name <vm>
```

`ssh` and `cp` use the store's own key and propagate the remote exit code. Push copies rather than mounting host directories, so the VM sees only what a real deployment would. `reset` rebuilds the disk from the VM's original image with a new cloud-init instance and keeps the name, port and credentials — use it between test rounds instead of uninstalling. `stop` powers off via ACPI and keeps the disk; `start` boots it again. `status` reports `image_outdated` when a newer build of the VM's image exists; create a new VM to use it.

## VM ownership and release

A VM is task data, so the Agent decides when to remove it, using the record written at creation: `--owner` (task or person responsible), `--purpose` and `--release-when` (a checkable condition, e.g. "install script passes and results are reported", "user finishes manual review", "failure is diagnosed and fixed"). `ls` shows these fields for every VM without passwords.

- Update the record with `annotate --name <vm> [--owner …] [--purpose …] [--release-when …]` when plans change — most importantly when a test fails and the VM becomes evidence ("keep until the Authing install failure is fixed").
- Run `rm` as soon as the release condition of a VM this task owns is met; do not keep VMs just in case. Removal also reclaims an outdated image disk it was the last user of.
- Never remove a VM another task or person owns, or one whose owner or condition is unclear; report it instead. Other sessions may share the store.

Report processes and data separately: a running VM is a QEMU process holding memory and its port; a stopped VM still keeps its disk. Use `stop` to free memory while keeping a VM for later review.

## Configuration directory

`~/.config/debian-testvm/` (`--config` selects another directory) holds personal defaults in `config.json` (mode `600`) and user components in `images/`. Keep it outside shared repositories, or version only `images/` there. `TESTVM_PASSWORD` overrides the password; without it or `password`, each VM gets a random one.

```json
{ "user": "dev", "password": "<local-only password>", "locale": "en_US.UTF-8", "timezone": "Etc/UTC",
  "release": "trixie", "defaultImage": "docker", "cpus": 2, "memory": 2048, "disk": "20G", "bind": "127.0.0.1",
  "authorizedKeyFiles": ["~/.ssh/id_ed25519.pub"] }
```

All keys are optional. `authorizedKeyFiles` defaults to existing `~/.ssh/id_ed25519.pub` / `id_rsa.pub`. Do not put passwords in commits, logs or public reports; deliver them only to the requester.

## Storage and failure handling

The store defaults to `~/.local/share/debian-testvm` (`--root` overrides): `images/<release>/` holds read-only disks and `index.json`; `instances/<name>/` holds the overlay disk, cloud-init seed, `serial.log` and state. Operations on one VM are serialized; a concurrent operation fails instead of waiting. Concurrent requests for the same layer wait for one build.

- `Runtime not ready` — run `doctor` and fix what it lists.
- Build failure or timeout — fix it on the spot; do not leave it for a person. The error includes the last `build.log` lines, and the kept `build-*` directory (named in the error; its `IMAGE` file names the layer) holds the full `build.log` (provision output) and `serial.log` (boot). Fix the component's `provision.sh` or files, or the host's network path for downloads, then rerun `image build` or `up`; a successful build of that layer deletes its failed build directories. If the composition is abandoned instead, `image rm <image>` deletes them. Report a failure you cannot fix with its cause and log excerpt, then remove its directory with `image rm`.
- `cloud-init reported error` / not ready — inspect with `ssh -- sudo cloud-init status --long` or `serial.log`.

## Verification

```bash
bun <skill-dir>/scripts/testvm.ts --help
bun test <skill-dir>/tests/doctor.test.ts  # no KVM, image or package installation needed
bun test <skill-dir>/tests/testvm.test.ts  # real VM lifecycle; prerequisites below
```

The lifecycle tests boot real VMs in the default store (or `TESTVM_TEST_ROOT`) and need the fetched `debian` image and a built `docker` image for the default release. They cover password login, Docker and Compose, the bare official image, copy, reset to a clean disk, user components composed through `requires` and with `docker`, layer caching and stale rebuilds, automatic reclaim of superseded layers, failed-build reporting and cleanup, VM annotations, protection of disks used by unknown VMs, and removal. Test components and their layers are removed afterwards. They fail rather than skip when KVM or images are unavailable.
