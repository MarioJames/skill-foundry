import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeServerConfig } from "../scripts/init-server-config.ts";

const roots: string[] = [];

function temporaryHome(): string {
  const root = mkdtempSync(join(tmpdir(), "persistent-ssh-init-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("init-server-config", () => {
  test("installs the runtime and user template without overwriting later profiles", () => {
    const home = temporaryHome();
    const first = initializeServerConfig(home);
    const runtime = join(home, ".config", "zsh", "server-runtime.zsh");
    const profiles = join(home, ".config", "zsh", "servers.zsh");
    const zshrc = join(home, ".zshrc");

    expect(first).toEqual({ runtime: "created", profiles: "created", zshrc: "updated" });
    expect(readFileSync(runtime, "utf8")).toContain("Managed by persistent-ssh-ops");
    expect(readFileSync(profiles, "utf8")).toContain("server_define keyhost");
    expect(statSync(runtime).mode & 0o777).toBe(0o700);
    expect(statSync(profiles).mode & 0o777).toBe(0o600);

    appendFileSync(profiles, "\nserver_define prod ubuntu 203.0.113.20 22 ''\n");
    const second = initializeServerConfig(home);
    expect(second).toEqual({ runtime: "unchanged", profiles: "preserved", zshrc: "unchanged" });
    expect(readFileSync(profiles, "utf8")).toContain("server_define prod ubuntu 203.0.113.20 22 ''");

    const startup = readFileSync(zshrc, "utf8");
    expect(startup.indexOf("server-runtime.zsh")).toBeLessThan(startup.indexOf("servers.zsh"));
  });

  test("inserts the runtime before an existing server profile source", () => {
    const home = temporaryHome();
    const zshrc = join(home, ".zshrc");
    const runtimeLine = '[[ -f "$HOME/.config/zsh/server-runtime.zsh" ]] && source "$HOME/.config/zsh/server-runtime.zsh"';
    const profilesLine = '[[ -f "$HOME/.config/zsh/servers.zsh" ]] && source "$HOME/.config/zsh/servers.zsh"';
    writeFileSync(zshrc, `# disabled: ${runtimeLine}\n${profilesLine}\n`);

    initializeServerConfig(home);

    const startup = readFileSync(zshrc, "utf8");
    expect(startup.split("\n").filter((line) => line === runtimeLine)).toHaveLength(1);
    expect(startup.split("\n").filter((line) => line === profilesLine)).toHaveLength(1);
    expect(startup.indexOf("server-runtime.zsh")).toBeLessThan(startup.indexOf("servers.zsh"));
    expect(existsSync(join(home, ".config", "zsh", "server-runtime.zsh"))).toBeTrue();
  });
});
