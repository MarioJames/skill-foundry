import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { captureCommand, filterHostAliases, parseAliasStream } from "../scripts/scan-hosts.ts";

const SCANNER = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "scan-hosts.ts");

describe("scan-hosts", () => {
  test("parses the delimited stream and keeps only safe SSH aliases", () => {
    const begin = "__BEGIN__";
    const end = "__END__";
    const stream = Buffer.from([
      "shell noise",
      `${begin}\0`,
      "prod\0command ssh prod.example\0",
      "bad alias\0ssh unsafe.example\0",
      "console\0echo hello\0",
      "jump\0autossh -M 0 jump.example\0",
      `${end}\0`,
      "trailing noise",
    ].join(""));

    expect(filterHostAliases(parseAliasStream(stream, begin, end))).toEqual([
      { alias: "jump", transport: "autossh", command: "autossh -M 0 jump.example" },
      { alias: "prod", transport: "ssh", command: "command ssh prod.example" },
    ]);
  });

  test("builds commands only for supported login shells", () => {
    expect(captureCommand("zsh", "begin", "end")).toContain("${(ok)aliases}");
    expect(captureCommand("bash", "begin", "end")).toContain("${!BASH_ALIASES[@]}");
    expect(() => captureCommand("fish", "begin", "end")).toThrow("unsupported login shell: fish");
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
