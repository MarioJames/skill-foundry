#!/usr/bin/env bun

import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  listWorkspacePackages,
  parsePnpmWorkspaceGlobs,
} from "../scripts/discovery.ts";

const entry = join(import.meta.dir, "..", "scripts", "workspace_graph.ts");

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function seedWorkspace(workspace: string): void {
  const frontend = join(workspace, "console");
  const backend = join(workspace, "service");
  mkdirSync(join(frontend, ".git"), { recursive: true });
  mkdirSync(join(backend, ".git"), { recursive: true });
  mkdirSync(join(frontend, "src/pages/Orders"), { recursive: true });
  mkdirSync(join(frontend, "src/pages/Users"), { recursive: true });
  mkdirSync(join(frontend, "src/services/service"), { recursive: true });
  write(
    join(frontend, "package.json"),
    JSON.stringify(
      {
        name: "console",
        packageManager: "bun@1.3.14",
        scripts: {
          devs: "MOCK=none bigfish dev",
          "test:journey": "bun test",
        },
      },
      null,
      2,
    ),
  );
  write(join(frontend, "README.md"), "# Console\n");
  write(join(frontend, "config/config.ts"), "export const service = 'service';\n");
  write(join(frontend, "config/routes/orders.ts"), "export default [];\n");
  write(join(frontend, "src/services/service/index.ts"), "export {};\n");
  write(join(backend, "README.md"), "# Service\n");
  write(
    join(backend, "pom.xml"),
    [
      "<project>",
      "  <modules>",
      "    <module>service-api</module>",
      "    <module>service-app</module>",
      "  </modules>",
      "  <artifactId>console</artifactId>",
      "</project>",
      "",
    ].join("\n"),
  );
}

function seedRichFacts(workspace: string): void {
  write(
    join(workspace, ".workspace/metadata.yaml"),
    JSON.stringify(
      {
        workspace: {
          name: "demo-workspace",
          summary: "多仓测试工作区。",
          positioning: "控制台通过 HTTP 消费服务端。",
          entry_policy: { delete_workspace_md: true },
          repo_order: ["service", "console"],
          task_routes: [
            {
              name: "服务端",
              when: "涉及 Maven 服务时使用。",
              read: [".workspace/repos/service/index.md"],
            },
            {
              name: "控制台",
              when: "涉及页面与路由时使用。",
              read: [".workspace/repos/console/index.md"],
            },
          ],
        },
        relations: [
          {
            from: "console",
            to: "service",
            type: "consumes_http",
            direction: "directed",
            summary: "console 通过配置和生成客户端消费 service。",
            evidence: ["console/config/config.ts", "service/pom.xml"],
          },
        ],
        standalone_repos: [],
        suppressed_relations: [],
        suppressed_relation_types: ["depends_on_repo_artifacts"],
      },
      null,
      2,
    ),
  );
  write(
    join(workspace, ".workspace/repos/console/index.md"),
    [
      "# console",
      "",
      "## 仓库事实",
      "",
      "| 字段 | 内容 |",
      "| --- | --- |",
      "| 类别 | `bigfish-console` |",
      "| 读者 | 控制台维护者。 |",
      "| 摘要 | 订单控制台。 |",
      "| 职责 | 提供页面和服务调用入口。 |",
      "| 主要入口 | [`config/config.ts`](../../../console/config/config.ts), `src/pages` |",
      "",
      "## 常用操作",
      "",
      "| 场景 | 命令/入口 | 说明 | 证据 |",
      "| --- | --- | --- | --- |",
      "| API 联调 | `bun run devs` | 保留的人工联调说明。 | [`console/package.json`](../../../console/package.json) |",
      "| 生成类型 | `bun generate` | 人工补充的操作。 | - |",
      "",
      "## 自定义边界",
      "",
      "这个小节由 agent 维护，刷新后必须保留。",
      "",
      "## 自动扫描快照",
      "",
      "- 旧快照应被替换。",
      "",
    ].join("\n"),
  );
  write(
    join(workspace, ".workspace/repos/service/index.md"),
    [
      "# service",
      "",
      "## Repository Facts",
      "",
      "| Field | Content |",
      "| --- | --- |",
      "| Category | `maven-service` |",
      "| Audience | 服务端维护者。 |",
      "| Summary | 订单服务。 |",
      "| Role | 提供订单能力。 |",
      "| Primary Entries | [`pom.xml`](../../../service/pom.xml) |",
      "",
      "## Common Operations",
      "",
      "| Scenario | Command/Entry | Notes | Evidence |",
      "| --- | --- | --- | --- |",
      "| 构建工具 | `mvn test / mvn package` | Maven 服务；使用 pom.xml 和模块 pom，不要运行 tnpm。 | [`service/pom.xml`](../../../service/pom.xml) |",
      "",
    ].join("\n"),
  );
  write(
    join(workspace, ".workspace/repos/console/domains/orders.md"),
    "## 摘要\n\n订单页面和路由的业务入口。\n\n## 入口\n\n- `Orders` 页面分组。\n",
  );
  write(
    join(workspace, ".workspace/repos/console/shared/integration.md"),
    "## 摘要\n\n服务客户端和联调配置。\n\n## 机制\n\n- `config/config.ts` 是配置入口。\n",
  );
  write(
    join(workspace, ".workspace/repos/service/domains/orders.md"),
    "## 摘要\n\n订单服务的 Maven 模块边界。\n",
  );
  write(
    join(workspace, "MEMORY.md"),
    [
      "# 工作区记忆",
      "",
      "记录这个工作区内重要的已完成操作，便于后续回忆。",
      "",
      "## workspace",
      "",
      "- 暂无操作记忆。",
      "- `2026-08-12` `[偏好]` 来源:用户明确说明;结论:保持中文输出。",
      "",
    ].join("\n"),
  );
  write(join(workspace, "WORKSPACE.md"), "# legacy\n");
}

function run(args: string[]) {
  const result = Bun.spawnSync(["bun", entry, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function command(command: string, workspace: string) {
  return run([command, "--workspace", workspace]);
}

test("完成 bootstrap、scan、init、validate 全工作流", () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-graph-"));
  const workspace = join(root, "workspace");
  try {
    seedWorkspace(workspace);
    expect(command("bootstrap", workspace)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const scan = command("scan", workspace);
    expect(scan.exitCode).toBe(0);
    expect(scan.stderr).toBe("");
    expect(scan.stdout).toBe(
      "已写入扫描快照：.workspace/state/discovery.json（2 个仓库）\n"
        + "- console: bigfish-console, bun@1.3.14\n"
        + "- service: maven-service, maven\n",
    );
    expect(command("init", workspace)).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(command("validate", workspace)).toEqual({
      exitCode: 0,
      stdout: "工作区图谱校验通过。\n",
      stderr: "",
    });
    const discovery = JSON.parse(
      readFileSync(
        join(workspace, ".workspace/state/discovery.json"),
        "utf8",
      ),
    );
    expect(discovery.workspace).toEqual({
      name: "workspace",
      path: realpathSync(workspace),
      repo_count: 2,
    });
    expect(discovery.repos.map((repo: { name: string }) => repo.name)).toEqual([
      "console",
      "service",
    ]);
    expect(
      readFileSync(
        join(workspace, ".workspace/repos/console/index.md"),
        "utf8",
      ),
    ).toContain("`bun devs`");
    expect(readFileSync(join(workspace, "CLAUDE.md"), "utf8")).toBe(
      "@AGENTS.md\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("保留帮助、参数错误和退出码", () => {
  expect(run(["--help"])).toMatchObject({
    exitCode: 0,
    stderr: "",
  });
  expect(run(["--help"]).stdout).toContain(
    "usage: workspace_graph.ts [-h] {bootstrap,scan,init,validate} ...",
  );
  const missing = run(["scan"]);
  expect(missing.exitCode).toBe(2);
  expect(missing.stdout).toBe("");
  expect(missing.stderr).toBe(
    "usage: workspace_graph.ts scan [-h] --workspace WORKSPACE\n"
      + "workspace_graph.ts scan: error: the following arguments are required: --workspace\n",
  );
  const unknown = run(["scan", "--workspace", "/tmp", "extra"]);
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stderr).toContain("error: unrecognized arguments: extra");
});

test("刷新时保留 agent 事实源并迁移旧记忆格式", () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-graph-rich-"));
  const workspace = join(root, "workspace");
  try {
    seedWorkspace(workspace);
    expect(command("bootstrap", workspace).exitCode).toBe(0);
    seedRichFacts(workspace);
    expect(command("init", workspace).exitCode).toBe(0);
    expect(command("init", workspace).exitCode).toBe(0);
    const consoleIndex = readFileSync(
      join(workspace, ".workspace/repos/console/index.md"),
      "utf8",
    );
    expect(consoleIndex).toContain("这个小节由 agent 维护，刷新后必须保留。");
    expect(consoleIndex).toContain("保留的人工联调说明。");
    expect(consoleIndex).not.toContain("旧快照应被替换。");
    const memory = readFileSync(join(workspace, "MEMORY.md"), "utf8");
    expect(memory).toContain("结论:保持中文输出。");
    expect(memory).not.toContain("记录这个工作区内重要的已完成操作");
    expect(memory).not.toContain("暂无操作记忆");
    expect(existsSync(join(workspace, "WORKSPACE.md"))).toBe(false);
    const registry = JSON.parse(
      readFileSync(
        join(workspace, ".workspace/relations/registry.yaml"),
        "utf8",
      ),
    );
    expect(registry.repo_order).toEqual(["service", "console"]);
    expect(registry.relations.map((item: { type: string }) => item.type)).toEqual([
      "consumes_api",
      "consumes_http",
    ]);
    const validation = command("validate", workspace);
    expect(validation.exitCode).toBe(0);
    expect(validation.stderr).toBe("");
    expect(validation.stdout).toContain("警告：");
    expect(validation.stdout).not.toContain("错误：");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("拒绝遗留声明和缺字段关系", () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-graph-invalid-"));
  try {
    const legacy = join(root, "legacy");
    write(
      join(legacy, ".workspace/metadata.yaml"),
      JSON.stringify({
        workspace: { name: "x", repo_order: [], task_routes: [] },
        relations: [],
        repos: {},
        memory_seed: [],
      }),
    );
    const legacyResult = command("init", legacy);
    expect(legacyResult.exitCode).toBe(1);
    expect(legacyResult.stdout).toContain(
      "包含遗留声明键 `repos`, `memory_seed`",
    );
    const malformed = join(root, "malformed");
    write(
      join(malformed, ".workspace/metadata.yaml"),
      JSON.stringify({
        workspace: { name: "x", repo_order: [], task_routes: [] },
        relations: [{ from: "a", to: "", summary: "bad" }],
      }),
    );
    const malformedResult = command("init", malformed);
    expect(malformedResult.exitCode).toBe(1);
    expect(malformedResult.stdout).toContain(
      "relations[0] 缺少非空字符串字段 `to`。",
    );
    expect(malformedResult.stdout).toContain(
      "relations[0] 缺少非空字符串字段 `type`。",
    );
    const invalidJson = join(root, "invalid-json");
    write(join(invalidJson, ".workspace/metadata.yaml"), "{bad\n");
    const invalidJsonResult = command("validate", invalidJson);
    expect(invalidJsonResult.exitCode).toBe(1);
    expect(invalidJsonResult.stderr).toBe("");
    expect(invalidJsonResult.stdout).toContain(
      ".workspace/metadata.yaml 必须使用 JSON 语法",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("按 pnpm workspace glob 稳定发现包", () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-graph-monorepo-"));
  try {
    write(
      join(root, "pnpm-workspace.yaml"),
      [
        "packages:",
        "  - 'packages/*'",
        "  - \"apps/*\"",
        "  - '!apps/ignored'",
        "",
      ].join("\n"),
    );
    write(join(root, "packages/zeta/package.json"), '{"name":"zeta"}\n');
    write(join(root, "packages/alpha/package.json"), '{"name":"alpha"}\n');
    write(join(root, "apps/web/package.json"), '{"name":"web"}\n');
    write(join(root, "apps/ignored/package.json"), '{"name":"ignored"}\n');
    expect(
      parsePnpmWorkspaceGlobs(join(root, "pnpm-workspace.yaml")),
    ).toEqual(["packages/*", "apps/*"]);
    expect(listWorkspacePackages(root, {})).toEqual([
      "alpha",
      "zeta",
      "ignored",
      "web",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
