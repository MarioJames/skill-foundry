# CLI 与规则格式

脚本运行环境为 Bun ≥ 1.3 和 ripgrep，Git 项目另需 Git。无第三方包、网络调用或任意命令执行。文本检查复用 ripgrep 的 Rust regex 引擎，逐行匹配；不支持跨行、反向引用、lookaround，不替代 AST lint、类型检查、依赖图或控制流分析。注释和字符串可能命中，别名/拆行可能漏报；语义规则应复用项目 ESLint、Biome、Semgrep 或依赖边界工具，按其现有版本和配置实现，不能用一个正则承诺完整语义覆盖。

## 命令

```bash
bun "$FA_DIR/scripts/accept.ts" scan --project "$PROJECT" [--base COMMIT] [--rules PROJECT_PATH]
bun "$FA_DIR/scripts/accept.ts" check-rules --project "$PROJECT" [--rules PROJECT_PATH]
bun "$FA_DIR/scripts/accept.ts" learn --project "$PROJECT" --feedback "$PRIVATE_FEEDBACK_JSON"
bun "$FA_DIR/scripts/accept.ts" promote --project "$PROJECT" --id project-example --review "$PRIVATE_REVIEW_JSON"
```

方括号表示可选参数，实际调用删除方括号。`--rules` 所有命令通用：优先指向项目已有、适合此格式的规则文件；没有时使用 `.agents/feature-acceptance/rules.json`。不搜索多层配置，不自动修改 AGENTS.md、package.json、CI 或 .gitignore。若项目已有原生 lint 配置，优先在原配置实现规则，本 JSON 只保留需 Agent review 的项目约束，避免两个重复真相源。

`scan/check-rules` 默认文件不存在时按无项目规则处理；显式 `--rules` 路径不存在时报错，避免拼错路径静默跳过门禁。规则路径必须在项目内且不能经过符号链接。Git 项目的 `--project` 必须为 Git 根，避免扫描相邻仓库。`learn` 将新规则设为 candidate，拒绝重复 ID；`promote` 只激活 candidate，验证失败不会写入半成品。写入用锁和原子替换，遇锁冲突交回 Agent，不能删除未知所有者的锁。

标准输出为 JSON，错误诊断为标准错误 JSON；不输出源代码片段、请求正文或环境值。`scan` 包含：

- `scope`、`source_digest`、`rules_digest`、`path_digest`：范围、正文、规则和路径清单的指纹，复验时仍应报告实际 Git 版本/diff。
- `files`、`path_files`、`excluded_count`、`skipped`：分别记录正文扫描、路径检查及排除情况。选入正文检查的二进制、非 UTF-8、超过 1 MiB 或符号链接文件会产生 incomplete/退出 2；已删除文件只记录不使扫描失败。
- `findings`：文件/规则/级别，文本命中含行号，路径检查含 `conflicts`；candidate 一律降为 warning。`suppressed` 保留有效例外的命中与原因，不把它藏掉。
- `review_queue`：项目规则中匹配到的人工审查项及文件，不按源码后缀重复生成内置主题清单；`unmatched_rules` 为未匹配到路径的规则，不能假定通过。
- `project_checks`：仅列出根 package.json 中 lint/test/typecheck/check 命名的脚本名称，不输出命令正文；未执行，也未确认其副作用。
- `verdict`：只有 `needs-review`、`blocking-findings`、`incomplete`，脚本从不签发功能 PASS。

扫描忽略 Git ignore 中未跟踪的文件（已跟踪文件仍列入），再排除依赖/生成物/环境与明显凭据路径。默认正文扩展名见 `SOURCE_GLOBS`，项目非 retired 的 pattern/review 规则可用 include 明确纳入 YAML、SQL 等其他文件，但不能绕过上述排除。路径检查不依赖正文扩展名，也不读取图片等资源的正文。扫描不是秘密扫描器，也不能证明穷尽业务文件。`--base` 包含指定 commit 到工作树的新增、修改、重命名/复制目的文件以及未忽略新文件；删除影响、导入链、相邻调用和存量债务需 Agent 补查。

## 规则对象

容器为 `{"version":1,"rules":[...]}`。`learn --feedback` 读取一个规则对象，不是容器。示例中的项目约定仅为演示，不能自动应用到别的项目：

```json
{
  "id": "project-error-channel",
  "title": "页面错误使用共享通知入口",
  "area": "frontend",
  "status": "candidate",
  "severity": "error",
  "include": ["src/pages/**/*.tsx"],
  "exclude": ["**/*.test.tsx"],
  "rationale": "该项目共享请求层已负责报错，页面再调用旧入口会产生重复通知。",
  "guidance": "核对共享错误通道，字段错误保留字段校验；静态风险说明不受此规则限制。",
  "sources": [{"ref": "issue:123#feedback-2", "summary": "用户要求同一次失败只出现一次通知"}],
  "check": {"kind": "pattern", "pattern": "message\\.error\\s*\\("},
  "examples": {
    "bad": [{"path": "src/pages/edit.tsx", "content": "message.error(errorText);"}],
    "good": [{"path": "src/pages/edit.tsx", "content": "notifyFailure(normalizedError);"}]
  }
}
```

`area` 是 frontend/backend/shared。路径 glob 使用 Bun.Glob，项目根相对路径、正斜杠，include 至少一项；不能用绝对路径、`..` 或否定 `!` glob，排除项放 exclude。Bun 的 `**/*.tsx` 包含根文件，按实际正反例核对作用域。

`check.kind=path-case` 检查未排除的普通文件路径，输出 `conflicts`，差异扫描也会比对存量路径；它按 Unicode NFC 与小写归一化比较完整文件路径，不承诺覆盖所有文件系统的等价规则或目录合并冲突。

`check.kind=review` 使用 `prompt` 代替 pattern，只允许 warning，不自动阻断。布局、跨文件授权、async 时序等优先为 review 或原生测试。`active` 必须有 `review: {reviewer,evidence,date}`；pattern 激活还需至少一个能命中的 bad 和不命中的 good，全部样例路径落在 include/exclude 允许范围。这些检查验证检测器契约，不能替代实际用户要求、Agent 语义确认或完整项目 lint。

review JSON 示例：`{"reviewer":"current-agent","evidence":"任务私有报告路径#核对项目约定与误报反例","date":"2026-09-29"}`。用本次实际日期和证据位置，不能抄示例冒充已审查。例外为 `exceptions: [{glob,reason,until}]`，until 为 YYYY-MM-DD（UTC，当天仍有效），过期自动重新报告。只给窄范围必要例外，不能以全局排除掩盖失败。

修订现有规则由 Agent 精确编辑同一 ID、追加来源并重新验证；语义/检测器变化先退回 candidate、移除旧 review，然后重新晋升。撤销设 `retired` 并在 rationale 记录原因；不用删除历史来伪装从未失败。内置 seed ID 不得被项目覆盖，项目适用规则用新的项目 ID；内置规则定义保存在 `scripts/rules.json`，不在 references 重复维护。
