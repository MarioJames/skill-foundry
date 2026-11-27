# 分享链接细则

```bash
bun <skill-dir>/scripts/share.ts upload --file "<工作区根>/reports/<文件>.html" --task <任务名> [--name <名称>] [--mission <主任务>] [--public] [--release-when <释放条件>]
```

- 写入只经 `cf` CLI：每次先以完整参数 `--dry-run` 核对账户、桶和 key，再原样执行一次，失败不重试；同名对象已存在时拒绝，不覆盖。写入后重新列出对象，并读取公网链接核对 200、类型和 MD5。stdout 的 `url` 就是交付链接。
- 单文件放在 `<上海日期>/<文件名>`。页面经 `src`、`href`、`poster` 引用了本地文件时（报告的证据截图、清单所在的设计文档），脚本把它们一并上传，以工作区根为根放在 `<上海日期>/<名称>/` 下，线上相对链接照常可用；引用越出工作区根、指向隐藏路径或文件不存在时拒绝上传。`--name` 替换单文件的文件名或带资源时的目录名。
- **默认私有，整个分享域名要登录（Cloudflare Access）。** 只有给外部看的展示页才加 `--public`，对象整组放在 `public/<上海日期>/` 下，免登录但受限流和缓存保护。上传前按 [证据与资源交接](html-report.md#证据与资源交接) 检查敏感内容，被引用的证据同样会按所在目录公开。
- 文档修订后用新名称上传（如 `--name <原名>-v2.html`），把新链接给用户；旧版本和所有历史版本都永久保留，不回收。
- 在 Weaver 主任务里工作时上传带 `--mission <主任务>`。上传并核对成功后，脚本对入口页执行 `weaver artifact add --mission <主任务> --file <本地源> --url <公网链接>`；`weaver` 不在 PATH 或登记失败时上传结果照常返回，stdout 里给出 `artifactError` 和一条可手动补登的命令，链接不受影响。
- 页面正文里有邮箱地址（如仿真界面中的账号）时，把 `@` 写成 `&#64;`。分享域名开着 Cloudflare 邮箱混淆，会把地址改写成 `[email protected]` 链接并注入脚本，公网内容与桶内对象不一致，上传后的 MD5 核对失败；用 `<!--email_off-->` 包裹也不行，注释本身会被删掉。核对失败的那次上传按一次性对象删除，改好后用新名称重传。
- `--task` 用本任务名，与 worktree、容器 owner 标签一致。每次上传都会登记，保留、回收和扫描见 [R2 分享对象](../../agent-conduct/SKILL.md#r2-分享对象)。交付给用户的文档、报告、它们引用的证据和所有历史版本永久保留；只有自测和探测对象、核对失败的上传按一次性资源删除。`--release-when` 默认「永久保留」，通常不用写。
- 需要已登录的 `cf` CLI 和本机配置 `~/.config/r2-share/config.json`（`R2_SHARE_CONFIG` 可指定其他文件），写明 `account`、`bucket`、`domain`（桶已启用的自定义域名）和可省略的 `profile`，不写凭据；缺配置时脚本报错并给出格式。分享域名启用 Cloudflare Access 后，再加可省略的 `accessToken`，写 Jinnang 的 `jn://` 引用；脚本用 `jinnang run <引用> --env CF_ACCESS_CLIENT_ID=client_id --env CF_ACCESS_CLIENT_SECRET=client_secret -- …` 让上传后和删除后的核对请求带上 Access 服务令牌，令牌值只存在于子进程环境，不打印、不写日志、不进参数。引用指向的条目要有 `client_id` 和 `client_secret` 字段；配置 `accessToken` 时需要可用的 `jinnang`。
