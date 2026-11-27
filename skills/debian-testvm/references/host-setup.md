# Host setup

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

## Configuration directory

`~/.config/debian-testvm/` (`--config` selects another directory) holds personal defaults in `config.json` (mode `600`) and user components in `images/`. Keep it outside shared repositories, or version only `images/` there. `TESTVM_PASSWORD` overrides the password; without it or `password`, each VM gets a random one.

```json
{ "user": "dev", "password": "<local-only password>", "locale": "en_US.UTF-8", "timezone": "Etc/UTC",
  "release": "trixie", "defaultImage": "docker", "cpus": 2, "memory": 2048, "disk": "20G", "bind": "127.0.0.1",
  "authorizedKeyFiles": ["~/.ssh/id_ed25519.pub"] }
```

All keys are optional. `authorizedKeyFiles` defaults to existing `~/.ssh/id_ed25519.pub` / `id_rsa.pub`. Do not put passwords in commits, logs or public reports; deliver them only to the requester.

## Store

The store defaults to `~/.local/share/debian-testvm` (`--root` overrides): `images/<release>/` holds read-only disks and `index.json`; `instances/<name>/` holds the overlay disk, cloud-init seed, `serial.log` and state. Operations on one VM are serialized; a concurrent operation fails instead of waiting. Concurrent requests for the same layer wait for one build.
