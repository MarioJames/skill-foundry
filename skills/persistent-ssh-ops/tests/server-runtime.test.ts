import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeServerConfig } from "../scripts/init-server-config";

const roots: string[] = [];
function home(config: unknown = { servers: {} }) {
  const root = mkdtempSync(join(tmpdir(), "ssh-json-test-")); roots.push(root);
  initializeServerConfig(root);
  writeFileSync(join(root, ".config/zsh/servers.json"), typeof config === "string" ? config : JSON.stringify(config));
  return root;
}
function run(root: string, script: string, extra: Record<string, string> = {}) {
  const result = Bun.spawnSync(["zsh", "-fc", script], { env: { ...process.env, HOME: root, ZDOTDIR: root, ...extra }, stderr: "pipe", stdout: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}
const load = 'source "$HOME/.config/zsh/server-runtime.zsh"; printf "%s:%s:%s" "$SERVER_PROFILES_STATUS" "$SERVER_PROFILES_REASON" "${#SERVER_PROFILES}"';
const profile = { user: "alice", host: "target.invalid", password: "synthetic_secret_438" };
function fake(root: string, resolved = "user alice\nhostname target.invalid\nport 22\n") {
  const bin = join(root, "bin"); mkdirSync(bin);
  const log = join(root, "ssh-calls.jsonl");
  const executable = join(bin, "ssh");
  writeFileSync(executable, `#!/usr/bin/env bun
const args = process.argv.slice(2);
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith("SERVER_SSH_") || key === "SSH_ASKPASS" || key === "SSH_ASKPASS_REQUIRE")), leaked:Object.values(process.env).some(value=>value.includes("synthetic_secret_438"))})+"\\n");
if (args[0] === "-G") process.stdout.write(${JSON.stringify(resolved)});
`); chmodSync(executable, 0o700);
  return { PATH: `${bin}:${process.env.PATH}`, log };
}
function calls(log: string) { return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : []; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("valid empty configuration, absent file, unreadable path and corrupt data have distinct states", () => {
  const root = home();
  expect(run(root, load).out).toBe("ok:none:0");
  rmSync(join(root, ".config/zsh/servers.json"));
  expect(run(root, load).out).toBe("missing:absent:0");
  mkdirSync(join(root, ".config/zsh/servers.json"));
  expect(run(root, load).out).toBe("error:invalid_configuration:0");
});

test("single document, duplicate keys at every level, all profile fields and secret-safe failures", () => {
  const invalid = [
    "", '{"servers":{}} {"servers":{}}', '{"servers":{"one":{"user":"a","host":"h"}}} BROKEN synthetic_secret_438',
    '{"servers":{"one":{"user":"a","host":"h"}},"servers":{}}',
    '{"servers":{"one":{"user":"a","host":"h"},"one":{"user":"b","host":"i"}}}',
    '{"servers":{"one":{"user":"a","host":"h","host":"i"}}}',
    '{"servers":{"one":{"user":"a","host":"h","password":"synthetic_secret_438","password":"x"}}}',
    ...[ { port: 0 }, { port: 65536 }, { port: 1.5 }, { password: 3 }, { identity_file: "relative" }, { unknown: 1 },
      { password: "a\nb" }, { password: "a\0b" }, { identity_file: "/x\ny" }, { user: "bad user" }, { user: "alice\n" }, { host: "target.invalid\n" }, { host: "-o" } ]
      .map(bad => JSON.stringify({ servers: { valid: profile, invalid: { ...profile, ...bad } } })),
    JSON.stringify({ servers: {}, extra: "synthetic_secret_438" }),
    JSON.stringify({ servers: { ['a\n']: profile } }),
    '{"servers":[]}', '{"servers":{"Bad":{"user":"a","host":"h"}}}',
  ];
  for (const config of invalid) {
    const result = run(home(config), load);
    expect(result.out).toBe("error:invalid_configuration:0");
    expect(result.err).not.toContain(profile.password);
  }
});

test("reload removes owned aliases atomically, preserves replacements and handles every legal command-like name", () => {
  const names = ["server_ssh", "server_link", "local", "print", "jq", "command", "ssh", "alias", "typeset", "setopt", "builtin", "source", "return", "printf", "if", "for"];
  const root = home({ servers: Object.fromEntries(names.map(name => [name, profile])) });
  const empty = join(root, "empty.json"); writeFileSync(empty, '{"servers":{}}');
  const result = run(root, `source "$HOME/.config/zsh/server-runtime.zsh"
\\builtin source "$HOME/.config/zsh/server-runtime.zsh"
\\builtin printf '%s:%s\\n' "$SERVER_PROFILES_STATUS" "${names.map(n => `\${SERVER_PROFILES[${n}]}`).join("|")}"
\\builtin alias print='echo user-replacement'
/bin/cp "$HOME/empty.json" "$HOME/.config/zsh/servers.json"
\\builtin source "$HOME/.config/zsh/server-runtime.zsh"
\\builtin printf '%s:%s:%s' "$SERVER_PROFILES_STATUS" "\${#SERVER_PROFILES}" "$aliases[print]"`);
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out).toContain("ok:ssh://alice@target.invalid:22");
  expect(result.out).toEndWith("ok:0:echo user-replacement");
});

test("connection rereads the complete document, preserves argv boundaries and scopes non-secret binding", () => {
  const root = home({ servers: { prod: profile } }); const transport = fake(root);
  const result = run(root, 'source "$HOME/.config/zsh/server-runtime.zsh"; server_ssh prod -o "ProxyCommand=remote arg"; printf "%s" "${SERVER_SSH_USER-unset}"', transport);
  expect(result.code).toBe(0);
  const records = calls(transport.log); expect(records).toHaveLength(2);
  expect(records[1].args).toEqual(["-o", "StrictHostKeyChecking=accept-new", "-p", "22", "-o", "KbdInteractiveAuthentication=no", "--", "alice@target.invalid", "-o", "ProxyCommand=remote arg"]);
  expect(records[1].env.SERVER_SSH_USER).toBe("alice");
  expect(JSON.stringify(records)).not.toContain(profile.password);
  expect(records[1].leaked).toBe(false);
  expect(result.out).toBe("unset");
  expect(result.out + result.err).not.toContain(profile.password);
  writeFileSync(join(root, ".config/zsh/servers.json"), JSON.stringify({ servers: { prod: profile, bad: { ...profile, password: 7 } } }));
  expect(run(root, 'source "$HOME/.config/zsh/server-runtime.zsh"; server_ssh prod', transport).code).not.toBe(0);
  expect(calls(transport.log)).toHaveLength(2);
});

test("explicit identity preflight blocks missing, directory and unreadable files before SSH", () => {
  const root = home(); const transport = fake(root);
  for (const path of [join(root, "absent"), root]) {
    writeFileSync(join(root, ".config/zsh/servers.json"), JSON.stringify({ servers: { prod: { ...profile, identity_file: path } } }));
    expect(run(root, 'source "$HOME/.config/zsh/server-runtime.zsh"; server_ssh prod', transport).code).not.toBe(0);
    expect(calls(transport.log)).toHaveLength(0);
  }
  const key = join(root, "key"); writeFileSync(key, "synthetic"); chmodSync(key, 0);
  writeFileSync(join(root, ".config/zsh/servers.json"), JSON.stringify({ servers: { prod: { ...profile, identity_file: key } } }));
  expect(run(root, 'source "$HOME/.config/zsh/server-runtime.zsh"; server_ssh prod', transport).code).not.toBe(0);
  expect(calls(transport.log)).toHaveLength(0);
});

test("automatic password refuses either proxy while key mode preserves it", () => {
  for (const proxy of ["proxyjump jump.invalid", "proxycommand ssh jump.invalid -W %h:%p"]) {
    const root = home({ servers: { prod: profile } }); const transport = fake(root, `user alice\nhostname target.invalid\n${proxy}\n`);
    const result = run(root, 'source "$HOME/.config/zsh/server-runtime.zsh"; server_ssh prod', transport);
    expect(result.code).not.toBe(0); expect(calls(transport.log)).toHaveLength(1);
    writeFileSync(join(root, ".config/zsh/servers.json"), JSON.stringify({ servers: { prod: { ...profile, password: "" } } }));
    expect(run(root, 'source "$HOME/.config/zsh/server-runtime.zsh"; server_ssh prod', transport).code).toBe(0);
    expect(calls(transport.log)).toHaveLength(2);
  }
});

test("askpass emits only for the full ordinary prompt and unchanged binding, validates every profile in one parse", () => {
  const root = home({ servers: { prod: profile } });
  const env = { SERVER_SSH_ASKPASS: "1", SERVER_SSH_PROFILE: "prod", SERVER_SSH_USER: "alice", SERVER_SSH_HOST: "target.invalid", SERVER_SSH_PORT: "22", SERVER_SSH_IDENTITY_FILE: "", SERVER_SSH_PROMPT_USER: "alice", SERVER_SSH_PROMPT_HOST: "effective.invalid" };
  function ask(prompt: string) {
    const result = Bun.spawnSync(["zsh", join(root, ".config/zsh/server-runtime.zsh"), prompt], { env: { ...process.env, HOME: root, ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  }
  const ordinary = "alice@effective.invalid's password: ";
  expect(ask(ordinary)).toEqual({ code: 0, out: profile.password + "\n", err: "" });
  for (const prompt of [ordinary.trimEnd(), "alice@target.invalid's password: ", "bob@effective.invalid's password: ", "Enter passphrase for key: ", "OTP password: ", "Enter alice@effective.invalid's old password: ", "New password: ", "Are you sure you want to continue connecting (yes/no)? "]) {
    expect(ask(prompt).code).not.toBe(0); expect(ask(prompt).out).toBe("");
  }
  for (const changed of [{ host: "other.invalid" }, { user: "bob" }, { port: 2222 }, { identity_file: "/changed" }]) {
    writeFileSync(join(root, ".config/zsh/servers.json"), JSON.stringify({ servers: { prod: { ...profile, ...changed } } }));
    expect(ask(ordinary).out).toBe(""); expect(ask(ordinary).code).not.toBe(0);
  }
  writeFileSync(join(root, ".config/zsh/servers.json"), JSON.stringify({ servers: { prod: profile, invalid: { ...profile, port: -1 } } }));
  expect(ask(ordinary).out).toBe(""); expect(ask(ordinary).code).not.toBe(0);
});

test("initializer validates before writes, preserves valid JSON and secures installed resources", () => {
  const root = home({ servers: { prod: profile } });
  const runtime = join(root, ".config/zsh/server-runtime.zsh"); const json = join(root, ".config/zsh/servers.json"); const rc = join(root, ".zshrc");
  const original = readFileSync(json, "utf8");
  expect(initializeServerConfig(root).profiles).toBe("preserved");
  expect(readFileSync(json, "utf8")).toBe(original); expect(statSync(json).mode & 0o777).toBe(0o600); expect(statSync(runtime).mode & 0o777).toBe(0o700);
  writeFileSync(json, "invalid synthetic_secret_438"); const before = [runtime, rc].map(path => readFileSync(path, "utf8"));
  expect(() => initializeServerConfig(root)).toThrow();
  expect([runtime, rc].map(path => readFileSync(path, "utf8"))).toEqual(before);
  writeFileSync(json, original); writeFileSync(runtime, "unmanaged");
  expect(() => initializeServerConfig(root)).toThrow("unmanaged runtime"); expect(readFileSync(runtime, "utf8")).toBe("unmanaged");
});

test("real OpenSSH -G respects -- before destination and remote -o remains a command", () => {
  const result = Bun.spawnSync(["ssh", "-F", "/dev/null", "-G", "-p", "2222", "--", "alice@target.invalid", "-o", "ProxyCommand=must-not-apply"], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0); const config = result.stdout.toString();
  expect(config).toContain("user alice\n"); expect(config).toContain("port 2222\n"); expect(config).not.toContain("proxycommand");
});

test("unsearchable configuration parents are errors and do not become missing", () => {
  const root = home({ servers: { prod: profile } }); const directory = join(root, ".config");
  chmodSync(directory, 0o600);
  try { expect(run(root, 'source "$RUNTIME_SOURCE"; printf "%s:%s:%s" "$SERVER_PROFILES_STATUS" "$SERVER_PROFILES_REASON" "${#SERVER_PROFILES}"', { RUNTIME_SOURCE: join(import.meta.dir, "../assets/server-runtime.zsh") }).out).toBe("error:invalid_configuration:0"); }
  finally { chmodSync(directory, 0o700); }
});

test("a failed or truncated producer cannot retain old or partially registered profiles", () => {
  const root = home({ servers: { prod: profile } }); const bin = join(root, "broken-bin"); mkdirSync(bin);
  const jq = join(bin, "jq");
  for (const [complete, exit] of [[false, 0], [true, 7]] as const) {
    const fields = ["server-config-v1", "partial", "alice", "target.invalid", "22", "", "false"];
    if (complete) fields.push("end");
    writeFileSync(jq, `#!/bin/sh\nprintf '%s\\0' ${fields.map(field => "'" + field + "'").join(" ")}\nexit ${exit}\n`);
    chmodSync(jq, 0o700);
    const result = run(root, `source "$HOME/.config/zsh/server-runtime.zsh"
PATH="$HOME/broken-bin:$PATH"
source "$HOME/.config/zsh/server-runtime.zsh"
printf '%s:%s:%s:%s' "$SERVER_PROFILES_STATUS" "\${#SERVER_PROFILES}" "\${+aliases[prod]}" "\${+aliases[partial]}"`);
    expect(result.out).toBe("error:0:0:0");
    expect(result.err).not.toContain(profile.password);
  }
});

test("key connections normalize explicit paths once and IPv6 URIs have brackets", () => {
  const root = home(); const transport = fake(root); const key = join(root, "literal key % ${TOKEN}"); writeFileSync(key, "synthetic");
  writeFileSync(join(root, ".config/zsh/servers.json"), JSON.stringify({ servers: { prod: { user: "alice", host: "2001:db8::1", identity_file: "~/./literal key % ${TOKEN}" } } }));
  const result = run(root, 'source "$HOME/.config/zsh/server-runtime.zsh"; server_link prod; server_ssh prod uptime', transport);
  expect(result.code).toBe(0); expect(result.out).toBe("ssh://alice@[2001:db8::1]:22\n");
  const records = calls(transport.log); expect(records).toHaveLength(1);
  expect(records[0].env.SERVER_SSH_IDENTITY_FILE).toBe(key);
  expect(records[0].args).toEqual(["-o", "StrictHostKeyChecking=accept-new", "-p", "22", "-o", "IdentityFile=${SERVER_SSH_IDENTITY_FILE}", "-o", "IdentitiesOnly=yes", "--", "alice@2001:db8::1", "uptime"]);
});

test("effective HostKeyAlias none remains a literal prompt host", () => {
  const root = home({ servers: { prod: profile } }); const transport = fake(root, "user alice\nhostname rewritten.invalid\nhostkeyalias none\n");
  expect(run(root, 'source "$HOME/.config/zsh/server-runtime.zsh"; server_ssh prod', transport).code).toBe(0);
  expect(calls(transport.log)[1].env.SERVER_SSH_PROMPT_HOST).toBe("none");
});

test("direct runtime entry and unavailable jq use the same configuration contract", () => {
  const root = home({ servers: { prod: { ...profile, password: "" } } }); const transport = fake(root);
  const result = Bun.spawnSync([join(root, ".config/zsh/server-runtime.zsh"), "prod", "uptime"], { env: { ...process.env, HOME: root, PATH: transport.PATH }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0); expect(calls(transport.log)[0].args.at(-1)).toBe("uptime");
  expect(run(root, `PATH=/nonexistent; source "$HOME/.config/zsh/server-runtime.zsh"; printf '%s:%s' "$SERVER_PROFILES_STATUS" "$SERVER_PROFILES_REASON"`).out).toBe("error:jq_required");
});

test.each(["command deploy", "sessiontype exec"])("real OpenSSH Match %s rejects JSON passwords before connecting", (condition) => {
  const root = home({ servers: { prod: profile } });
  const bin = join(root, "bin"); mkdirSync(bin);
  const config = join(root, "ssh_config");
  const preflight = join(root, "preflight.json");
  const attempted = join(root, "connection-attempted");
  const realSsh = Bun.which("ssh")!;
  writeFileSync(config, `Host *\n  CanonicalizeHostname no\nMatch ${condition}\n  ProxyJump jump.invalid\n`);
  writeFileSync(join(bin, "ssh"), `#!/usr/bin/env bun
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "-G") {
  fs.writeFileSync(${JSON.stringify(attempted)}, "blocked by test wrapper");
  process.exit(97);
}
const result = Bun.spawnSync([${JSON.stringify(realSsh)}, "-F", ${JSON.stringify(config)}, ...args], {stdin:"ignore", stdout:"pipe", stderr:"pipe"});
fs.writeFileSync(${JSON.stringify(preflight)}, JSON.stringify({code:result.exitCode, proxy:result.stdout.toString().includes("proxyjump jump.invalid\\n")}));
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.exitCode);
`);
  chmodSync(join(bin, "ssh"), 0o700);
  const result = run(root, 'source "$HOME/.config/zsh/server-runtime.zsh"; server_ssh prod deploy', { PATH: `${bin}:${process.env.PATH}` });
  expect(result.code).not.toBe(0);
  expect(JSON.parse(readFileSync(preflight, "utf8"))).toEqual({ code: 0, proxy: true });
  expect(existsSync(attempted)).toBe(false);
  expect(result.err).toContain("unavailable with SSH proxies");
});

test.each(["22.0", "2.2e1"])("integer JSON port %s normalizes URI, SSH argv and askpass binding", (port) => {
  const root = home(`{"servers":{"prod":{"user":"alice","host":"target.invalid","port":${port},"password":"synthetic_secret_438"}}}`);
  const transport = fake(root);
  const result = run(root, 'source "$HOME/.config/zsh/server-runtime.zsh"; server_link prod; server_ssh prod deploy', transport);
  expect(result.code).toBe(0);
  expect(result.out).toBe("ssh://alice@target.invalid:22\n");
  const connection = calls(transport.log)[1];
  expect(connection.args[connection.args.indexOf("-p") + 1]).toBe("22");
  expect(connection.env.SERVER_SSH_PORT).toBe("22");
  const answer = Bun.spawnSync([join(root, ".config/zsh/server-runtime.zsh"), "alice@target.invalid's password: "], {
    env: { ...process.env, HOME: root, ZDOTDIR: root, ...connection.env }, stdout: "pipe", stderr: "pipe",
  });
  expect(answer.exitCode).toBe(0);
  expect(answer.stdout.toString() === profile.password + "\n").toBe(true);
  expect(answer.stderr.toString()).toBe("");
});
