import { describe, expect, test } from "bun:test";
import { writeFileSync, chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  captureCommand,
  filterHostAliases,
  filterServerProfiles,
  parseDiscoveryStream,
  effectiveDiscovery,
} from "../../skills/persistent-ssh-ops/scripts/scan-hosts.ts";
import { initializeServerConfig } from "../../skills/persistent-ssh-ops/scripts/init-server-config.ts";

const SCANNER = join(dirname(fileURLToPath(import.meta.url)), "../../skills/persistent-ssh-ops", "scripts", "scan-hosts.ts");

describe("scan-hosts", () => {
  test("parses registered server profiles separately from legacy SSH aliases", () => {
    const begin = "__BEGIN__";
    const end = "__END__";
    const stream = Buffer.from([
      "shell noise",
      `${begin}\0`,
      "status\0runtime\0ok:none\0",
      "profile\0prodhost\0ssh://root@203.0.113.10:22\0",
      "profile\0bad-name\0ssh://root@203.0.113.11:22\0",
      "profile\0wronguri\0https://example.com\0",
      "alias\0prod\0command ssh prod.example\0",
      "alias\0bad alias\0ssh unsafe.example\0",
      "alias\0console\0echo hello\0",
      "alias\0jump\0autossh -M 0 jump.example\0",
      `${end}\0`,
      "trailing noise",
    ].join(""));
    const records = parseDiscoveryStream(stream, begin, end);

    expect(filterServerProfiles(records)).toEqual([
      { name: "prodhost", uri: "ssh://root@203.0.113.10:22" },
    ]);
    expect(filterHostAliases(records)).toEqual([
      { alias: "jump", transport: "autossh", command: "autossh -M 0 jump.example" },
      { alias: "prod", transport: "ssh", command: "command ssh prod.example" },
    ]);
  });

  test("builds commands only for supported login shells", () => {
    expect(captureCommand("zsh", "begin", "end")).toContain("${(ok)aliases}");
    expect(captureCommand("zsh", "begin", "end")).toContain("${(ok)SERVER_PROFILES}");
    expect(captureCommand("zsh", "begin", "end")).toContain("functions[server_ssh]");
    expect(captureCommand("bash", "begin", "end")).toContain("${!BASH_ALIASES[@]}");
    expect(() => captureCommand("fish", "begin", "end")).toThrow("unsupported login shell: fish");
  });

  test("discovers an initialized server profile through a real zsh login shell", () => {
    const zsh = Bun.which("zsh");
    if (!zsh) return;

    const root = mkdtempSync(join(tmpdir(), "scan-hosts-profile-"));
    try {
      initializeServerConfig(root);
      writeFileSync(join(root, ".config", "zsh", "servers.json"), JSON.stringify({ servers: {
        prodhost: { user: "deploy", host: "203.0.113.30", port: 2222 },
        printf: { user: "deploy", host: "example.invalid" }
      } }));
      const result = Bun.spawnSync({
        cmd: [process.execPath, SCANNER],
        env: { ...process.env, HOME: root, ZDOTDIR: root, SHELL: zsh },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = JSON.parse(result.stdout.toString());

      expect(result.exitCode).toBe(0);
      expect(output.schema_version).toBe(2);
      expect(output.server_profiles).toEqual([
        { name: "printf", uri: "ssh://deploy@example.invalid:22" },
        { name: "prodhost", uri: "ssh://deploy@203.0.113.30:2222" },
      ]);
      expect(output.host_aliases).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runs through explicit Bun when the installed copy has no execute bit", () => {
    const root = mkdtempSync(join(tmpdir(), "scan-hosts-mode-stripped-"));
    const installed = join(root, "scan-hosts.ts");
    try {
      copyFileSync(SCANNER, installed);
      chmodSync(installed, 0o644);
      const result = Bun.spawnSync({
        cmd: [process.execPath, installed, "--help"],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Usage: bun scan-hosts.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("discovery rejects absent, duplicate, invalid, error and not-loaded runtime status", () => {
  const record = (body: string) => Buffer.from(`BEGIN\0${body}END\0`);
  for (const body of ["", "status\0runtime\0ok:none\0status\0runtime\0ok:none\0", "status\0runtime\0bogus\0", "status\0runtime\0error:invalid_configuration\0", "status\0runtime\0not_loaded:not_loaded\0", "status\0runtime\0missing:absent\0profile\0one\0ssh://a@b:22\0", "status\0runtime\0ok:none\0truncated\0"]) {
    expect(() => parseDiscoveryStream(record(body), "BEGIN", "END")).toThrow();
  }
  expect(parseDiscoveryStream(record("status\0runtime\0missing:absent\0"), "BEGIN", "END")).toHaveLength(1);
  expect(parseDiscoveryStream(record("status\0runtime\0not_applicable:bash\0"), "BEGIN", "END")).toHaveLength(1);
});

test("discovery rejects a failed shell even after it printed a complete valid envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-json-scanner-"));
  const shell = join(root, "zsh");
  try {
    writeFileSync(shell, '#!/usr/bin/env zsh\nSERVER_PROFILES_STATUS=ok SERVER_PROFILES_REASON=none\neval "$2"\nexit 9\n');
    chmodSync(shell, 0o700);
    expect(() => effectiveDiscovery(shell)).toThrow("login shell failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
