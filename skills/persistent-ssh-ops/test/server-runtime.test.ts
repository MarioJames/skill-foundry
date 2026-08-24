import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_SOURCE = join(SKILL_ROOT, "scripts", "server-runtime.zsh");
const roots: string[] = [];

function fixture(): { env: Record<string, string>; runtime: string } {
  const home = mkdtempSync(join(tmpdir(), "persistent-ssh-runtime-"));
  roots.push(home);
  const configDirectory = join(home, ".config", "zsh");
  const binDirectory = join(home, "bin");
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(binDirectory, { recursive: true });

  const runtime = join(configDirectory, "server-runtime.zsh");
  copyFileSync(RUNTIME_SOURCE, runtime);
  chmodSync(runtime, 0o700);
  writeFileSync(join(configDirectory, "servers.zsh"), `
source "$HOME/.config/zsh/server-runtime.zsh"
server_define keyhost ubuntu 203.0.113.20 2222 ''
server_define passhost root 203.0.113.21 2223 'test password'
`);

  const fakeSsh = join(binDirectory, "ssh");
  writeFileSync(fakeSsh, `#!/usr/bin/env zsh
if [[ -n "\${SSH_ASKPASS:-}" ]]; then
  supplied="$("$SSH_ASKPASS" Password:)" || exit
  [[ "$supplied" == "\${SERVER_TEST_EXPECTED:-}" ]] || exit 90
  print -r -- "password:$*"
else
  print -r -- "key:$*"
fi
`);
  chmodSync(fakeSsh, 0o700);

  return {
    runtime,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDirectory}:${process.env.PATH || "/usr/bin:/bin"}`,
      SERVER_TEST_EXPECTED: "test password",
    },
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("server-runtime", () => {
  test("registers profiles and exposes password-free SSH URIs", () => {
    const { env } = fixture();
    const result = Bun.spawnSync({
      cmd: ["zsh", "-f", "-c", 'source "$HOME/.config/zsh/servers.zsh"; server_link keyhost; print -r -- "$SERVER_PROFILES[passhost]"'],
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim().split("\n")).toEqual([
      "ssh://ubuntu@203.0.113.20:2222",
      "ssh://root@203.0.113.21:2223",
    ]);
    expect(result.stdout.toString()).not.toContain("test password");
  });

  test("direct execution selects key or SSH_ASKPASS without exposing the password", () => {
    const { env, runtime } = fixture();
    const key = Bun.spawnSync({ cmd: [runtime, "keyhost", "uptime"], env, stdout: "pipe", stderr: "pipe" });
    const password = Bun.spawnSync({ cmd: [runtime, "passhost", "whoami"], env, stdout: "pipe", stderr: "pipe" });

    expect(key.exitCode).toBe(0);
    expect(key.stdout.toString()).toContain("key:-o StrictHostKeyChecking=accept-new -p 2222 ubuntu@203.0.113.20 uptime");
    expect(password.exitCode).toBe(0);
    expect(password.stdout.toString()).toContain("password:-o StrictHostKeyChecking=accept-new -p 2223 root@203.0.113.21 whoami");
    expect(password.stdout.toString()).not.toContain("test password");
  });
});
