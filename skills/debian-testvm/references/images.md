# Images and components

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

## Build failures

Fix a build failure or timeout on the spot; do not leave it for a person. The error includes the last `build.log` lines, and the kept `build-*` directory (named in the error; its `IMAGE` file names the layer) holds the full `build.log` (provision output) and `serial.log` (boot). Fix the component's `provision.sh` or files, or the host's network path for downloads, then rerun `image build` or `up`; a successful build of that layer deletes its failed build directories. If the composition is abandoned instead, `image rm <image>` deletes them. Report a failure you cannot fix with its cause and log excerpt, then remove its directory with `image rm`.
