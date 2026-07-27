import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { initializeRun } from "../scripts/agent_orchestrator.ts";
import {
  GOALS,
  boundedCleanup,
  classifyPermissionDeny,
  hasSafeWorkspaceMode,
  hasWriteCapableMode,
  tokenResidue,
} from "./manual_real_acp.ts";
import { probe } from "./manual_acp_handshake.ts";
import { FAKE_AGENT, SKILL_DIR, isolatedRuntime } from "./helpers.ts";

const ALIAS_DIR = resolve(SKILL_DIR, "..", "agent-swarm");
const REPOSITORY_ROOT = resolve(SKILL_DIR, "..", "..");

function allFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files.sort();
}

describe("TypeScript manual harness", () => {
  test("real matrix includes crash and task-tree scenarios", () => {
    expect(GOALS["agent-crash"]).toBeDefined();
    expect(GOALS.orchestration).toBeDefined();
  });

  test("token residue reports only files containing plaintext tokens", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-orchestrator-residue-"));
    try {
      writeFileSync(join(root, "safe.log"), "safe");
      writeFileSync(join(root, "unsafe.log"), "prefix-secret-token-suffix");
      expect(tokenResidue(root, ["secret-token"])).toEqual(["unsafe.log"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("permission evidence distinguishes callback and native sandbox outcomes", () => {
    expect(hasSafeWorkspaceMode([{ configured: { mode: "agent" } }])).toBe(true);
    for (const mode of ["agent-full-access", "bypassPermissions", "full-access"]) {
      expect(hasWriteCapableMode([{ configured: { mode } }])).toBe(true);
    }
    const callback = classifyPermissionDeny({ outsideExists: false, permissionEvents: [{ allowed: false }], safeWorkspaceMode: true });
    const native = classifyPermissionDeny({ outsideExists: false, permissionEvents: [], safeWorkspaceMode: true });
    expect(callback).toMatchObject({ evidence: "acp_callback_deny", acp_permission_callback_passed: true });
    expect(native).toMatchObject({ evidence: "native_sandbox_deny", acp_permission_callback_passed: false });
  });

  test("bounded cleanup always attempts canonical Runtime stop", async () => isolatedRuntime(({ cwd }) => {
    const identity = initializeRun("cleanup", cwd, { backend: "claude_cli" });
    const result = boundedCleanup(identity);
    expect(result.error).toBeNull();
    expect(result.stop.status).toBe("cancelled");
  }));

  test("standalone official SDK handshake succeeds against the TypeScript fake Agent", async () => isolatedRuntime(async ({ cwd }) => {
    const report = await probe({
      command: process.execPath,
      commandArgs: [FAKE_AGENT, "--scenario", "history"],
      cwd,
    });
    expect(report.ok).toBe(true);
    expect(String(report.sessionId).startsWith("fake-session-")).toBe(true);
    expect(report.cleanup.processGroupAbsent).toBe(true);
  }));
});

describe("explicit trigger boundary and clean-break package", () => {
  test("canonical frontmatter is explicit-only and rejects incidental mentions", () => {
    const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
    const frontmatter = skill.split("---")[1]!;
    expect(frontmatter).toContain("Explicit task-tree orchestration");
    expect(frontmatter).toContain("Do not trigger for ordinary reviews");
    expect(frontmatter).toContain("paths or links");
    expect(frontmatter).toContain("quoted or example mentions");
  });

  test("product metadata disables implicit invocation for canonical and alias Skills", () => {
    for (const path of [join(SKILL_DIR, "agents", "openai.yaml"), join(ALIAS_DIR, "agents", "openai.yaml")]) {
      expect(readFileSync(path, "utf8")).toContain("allow_implicit_invocation: false");
    }
  });

  test("Skill routes detailed contracts one level down and documents three trigger layers", () => {
    const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
    expect(skill.split("\n").length).toBeLessThan(130);
    for (const reference of ["runtime-contract.md", "action-schemas.md", "operating-modes.md", "review-consensus.md", "recovery-protocol.md", "acp-sdk.md"]) {
      expect(skill).toContain(`references/${reference}`);
    }
    const modes = readFileSync(join(SKILL_DIR, "references", "operating-modes.md"), "utf8");
    expect(modes).toContain("Explicit user wording / CLI hint");
    expect(modes).toContain("Persisted `entry_mode`");
    expect(modes).toContain("Required `start_mode.mode`");
    expect(modes).toContain("The Action is the only event that creates a mode state machine");
  });

  test("all published Runtime commands route through bootstrap", () => {
    const documents = [
      join(REPOSITORY_ROOT, "README.md"), join(SKILL_DIR, "SKILL.md"),
      ...allFiles(join(SKILL_DIR, "references")), join(ALIAS_DIR, "SKILL.md"),
      join(REPOSITORY_ROOT, "skills", "docs", "specs", "acp-backend-spec.md"),
    ].map((path) => readFileSync(path, "utf8")).join("\n");
    expect(documents).not.toMatch(/(?:python3|bun)\s+[^\n`]*agent_orchestrator\.(?:py|ts)/u);
    expect(documents).toContain("scripts/bootstrap.ts");
  });

  test("canonical Runtime and alias contain no duplicate implementation or legacy sources", () => {
    const canonicalFiles = allFiles(SKILL_DIR).filter((path) => !path.includes(`${join(SKILL_DIR, "node_modules")}/`));
    expect(canonicalFiles.some((path) => path.endsWith(".py"))).toBe(false);
    expect(canonicalFiles.some((path) => /(?:\.whl|\.zip)$/iu.test(path))).toBe(false);
    const aliasFiles = allFiles(ALIAS_DIR).map((path) => path.slice(ALIAS_DIR.length + 1));
    expect(aliasFiles.sort()).toEqual(["SKILL.md", "agents/openai.yaml", "scripts/bootstrap.ts"]);
  });

  test("manifest pins the audited graph and bootstrap imports only built-ins", () => {
    const metadata = JSON.parse(readFileSync(join(SKILL_DIR, "package.json"), "utf8"));
    expect(metadata.dependencies).toEqual({
      "@agentclientprotocol/claude-agent-acp": "0.62.0",
      "@agentclientprotocol/codex-acp": "1.1.7",
      "@agentclientprotocol/sdk": "1.3.0",
      "@anthropic-ai/claude-agent-sdk": "0.3.219",
      "@openai/codex": "0.145.0",
    });
    expect(metadata.devDependencies["@google/gemini-cli"]).toBe("0.41.0");
    expect(metadata.trustedDependencies).toEqual([]);
    const bootstrap = readFileSync(join(SKILL_DIR, "scripts", "bootstrap.ts"), "utf8");
    for (const match of bootstrap.matchAll(/from\s+["']([^"']+)["']/gu)) {
      expect(match[1]!.startsWith("node:")).toBe(true);
    }
  });
});
