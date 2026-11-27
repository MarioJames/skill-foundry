---
name: debian-testvm
description: 在 Linux/WSL2 主机上用 QEMU/KVM 快速拉起干净的 Debian Stable 虚拟机，交付 SSH 地址、用户名和密码，用于验证安装、部署和运维脚本在全新系统上的可用性；镜像由可组合的组件按需叠加（内置 docker，用户可在配置目录自定义），也可使用未改动的官方镜像。
---

# Debian Test VM

Disposable Debian VMs from the official cloud image, for testing scripts on a clean system. A VM is a copy-on-write overlay of a cached image, so creating or resetting one takes seconds. Networking is QEMU user-mode NAT with one forwarded SSH port.

Every command is `bun <skill-dir>/scripts/testvm.ts <command>`; `--help` lists all commands, options and defaults. Output is JSON, errors are JSON on stderr.

| When | Read |
| --- | --- |
| First use on this host, or `doctor` reports something missing | [Host setup](references/host-setup.md) |
| An image other than `debian` or `docker`, writing a component, or a build fails | [Images and components](references/images.md) |

## Deliver a VM

```bash
bun <skill-dir>/scripts/testvm.ts doctor
bun <skill-dir>/scripts/testvm.ts up --purpose "<what is tested>" --release-when "<condition>" --owner "<task>" [--image debian|docker+nodejs] [--name <vm>]
```

- `up` returns only after SSH answers and cloud-init has finished. Hand the requester `url`, `ssh`, `user`, `password`, `image` and `versions`. Keep the password out of commits, logs and public reports.
- `--image` defaults to `docker`. Choose `debian` when the script under test installs its own dependencies or must prove it works on a bare system; otherwise the smallest composition that matches the target.
- SSH binds to `127.0.0.1`. Use `--bind 0.0.0.0` only when the user asks for LAN access.

## Run tests inside

```bash
bun <skill-dir>/scripts/testvm.ts cp --name <vm> ./install.sh :/tmp/
bun <skill-dir>/scripts/testvm.ts ssh --name <vm> -- 'bash /tmp/install.sh'
bun <skill-dir>/scripts/testvm.ts cp --name <vm> :/var/log/app.log ./evidence/
bun <skill-dir>/scripts/testvm.ts reset --name <vm>
```

- Copy files in rather than mounting host directories, so the VM sees only what a real deployment would.
- `reset` between test rounds instead of uninstalling: it rebuilds the disk from the VM's image and keeps the name, port and credentials.
- `status` reports `image_outdated` when a newer build of the VM's image exists; create a new VM to use it.

## Ownership and release

`ls` shows every VM's `--owner`, `--purpose` and `--release-when` without passwords.

- Run `rm` as soon as the release condition of a VM this task owns is met. Do not keep VMs just in case; `stop` frees memory when one must be kept for review.
- When plans change, update the record with `annotate`, above all when a test fails and the VM becomes evidence.
- Never remove a VM another task or person owns, or one whose owner or condition is unclear; report it instead.
- In the final reply, report processes and data separately: a running VM holds memory and a port, a stopped one still keeps its disk.

## Failures

- `Runtime not ready`: run `doctor` and follow [Host setup](references/host-setup.md).
- Build failure or timeout: fix it on the spot, see [Images and components](references/images.md#build-failures).
- `cloud-init reported error` or not ready: `ssh --name <vm> -- sudo cloud-init status --long`, or read `instances/<vm>/serial.log` in the store.
