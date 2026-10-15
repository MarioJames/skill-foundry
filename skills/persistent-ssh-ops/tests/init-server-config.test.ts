import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeServerConfig } from "../scripts/init-server-config.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("initialization is repeatable, preserves user JSON and adds precisely one runtime source", () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-json-init-")); roots.push(root);
  const first = initializeServerConfig(root);
  expect(first).toEqual({ runtime: "created", validator: "created", profiles: "created", zshrc: "updated" });
  const profiles = join(root, ".config/zsh/servers.json");
  expect(JSON.parse(readFileSync(profiles, "utf8"))).toEqual({ servers: {} });
  writeFileSync(profiles, '{"servers":{"prod":{"user":"alice","host":"example.invalid"}}}\n');
  const before = readFileSync(profiles, "utf8");
  expect(initializeServerConfig(root)).toEqual({ runtime: "unchanged", validator: "unchanged", profiles: "preserved", zshrc: "unchanged" });
  expect(readFileSync(profiles, "utf8")).toBe(before);
  expect(statSync(profiles).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(root, ".zshrc"), "utf8").split("\n").filter(line => line.includes("&& source"))).toHaveLength(1);
});
test("commented source does not suppress installation and other startup content and modes survive", () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-json-init-")); roots.push(root);
  const line = '[[ -f "$HOME/.config/zsh/server-runtime.zsh" ]] && source "$HOME/.config/zsh/server-runtime.zsh"';
  writeFileSync(join(root, ".zshrc"), `# ${line}\nexport EXAMPLE=1`, { mode: 0o640 });
  initializeServerConfig(root);
  expect(readFileSync(join(root, ".zshrc"), "utf8")).toBe(`# ${line}\nexport EXAMPLE=1\n${line}\n`);
  expect(statSync(join(root, ".zshrc")).mode & 0o777).toBe(0o640);
});
