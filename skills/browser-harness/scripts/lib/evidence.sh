# skills/browser-harness/scripts/lib/evidence.sh
# bh collect-evidence 的实现。
# 流程：(har start) → open → snapshot/console/network 抓取 → screenshot → 落 summary.json。
# agent-browser >= 0.29 的 --json 输出统一是 {"success":true,"data":{...},"error":null} 信封；
# 本文件负责解包成裸数组/对象再落盘，counts 基于解包后的数组计算。
# open 失败硬退出（证据不可信就不产出）；单项 artifact 失败落 fallback 并记入 summary.artifact_errors。

bh_collect_evidence() {
  local url="$1"
  local profile="$2"
  local har="$3"      # "1" 或 ""
  local outdir_base="${4:-evidence}"

  bh_require_agent_browser

  # profile 名解析成技能私有目录路径，和 bh login 写入的目录一致，才能复用登录态。
  # --profile 不传时 bh_profile_dir 回退到默认 profile，因此始终带上，保证状态持久。
  local profile_path
  profile_path="$(bh_profile_dir "$profile")"
  local profile_args=(--profile "$profile_path")

  # HAR 必须先于 open 启动，才能覆盖首屏加载的请求。
  # 注意：空数组展开必须用 ${arr[@]+"${arr[@]}"} 惯例，
  # 否则在 macOS 系统自带 bash 3.2 + set -u 下会触发 "unbound variable" 崩溃。
  if [ "$har" = "1" ]; then
    bh_log "start HAR recording"
    agent-browser network har start ${profile_args[@]+"${profile_args[@]}"} >&2 || true
  fi

  # open 是采集的前提；失败时不产出证据目录，硬退出让上层归因。
  bh_log "open $url (profile=${profile:-<default>})"
  agent-browser open "$url" ${profile_args[@]+"${profile_args[@]}"} >&2 \
    || bh_die 3 "agent-browser open 失败：$url"

  local outdir_abs ts ev_dir
  case "$outdir_base" in
    /*) outdir_abs="$outdir_base" ;;
    *)  outdir_abs="$PWD/$outdir_base" ;;
  esac
  ts="$(date +%Y%m%dT%H%M%S)"
  # 同秒重复时加随机后缀。
  if [ -e "$outdir_abs/$ts" ]; then
    ts="${ts}-$$"
  fi
  ev_dir="$outdir_abs/$ts"
  mkdir -p "$ev_dir"

  # 逗号分隔的失败项清单，最终进 summary.artifact_errors。
  local artifact_errors=""

  bh_log "snapshot DOM"
  if ! agent-browser snapshot --json ${profile_args[@]+"${profile_args[@]}"} 2>/dev/null \
      | _bh_unwrap_envelope - '{}' >"$ev_dir/dom.json"; then
    artifact_errors="${artifact_errors:+$artifact_errors,}dom"
  fi

  bh_log "console messages"
  if ! agent-browser console --json ${profile_args[@]+"${profile_args[@]}"} 2>/dev/null \
      | _bh_unwrap_envelope messages '[]' >"$ev_dir/console.json"; then
    artifact_errors="${artifact_errors:+$artifact_errors,}console"
  fi

  bh_log "network xhr/fetch"
  if ! agent-browser network requests --type xhr,fetch --json ${profile_args[@]+"${profile_args[@]}"} 2>/dev/null \
      | _bh_unwrap_envelope requests '[]' >"$ev_dir/network-xhr.json"; then
    artifact_errors="${artifact_errors:+$artifact_errors,}network_xhr"
  fi

  bh_log "network 4xx/5xx"
  if ! agent-browser network requests --status 400-599 --json ${profile_args[@]+"${profile_args[@]}"} 2>/dev/null \
      | _bh_unwrap_envelope requests '[]' >"$ev_dir/network-errors.json"; then
    artifact_errors="${artifact_errors:+$artifact_errors,}network_errors"
  fi

  # screenshot 是位置参数收路径；--annotate 输出带 ref 编号的标注截图。
  bh_log "screenshot (annotated)"
  if ! agent-browser screenshot --annotate "$ev_dir/screenshot.png" ${profile_args[@]+"${profile_args[@]}"} >&2; then
    artifact_errors="${artifact_errors:+$artifact_errors,}screenshot"
  fi

  if [ "$har" = "1" ]; then
    bh_log "stop HAR recording"
    if ! agent-browser network har stop "$ev_dir/network.har" ${profile_args[@]+"${profile_args[@]}"} >&2; then
      artifact_errors="${artifact_errors:+$artifact_errors,}har"
    fi
  fi

  local xhr_count error_count
  xhr_count="$(_bh_count_json_array "$ev_dir/network-xhr.json")"
  error_count="$(_bh_count_json_array "$ev_dir/network-errors.json")"

  # 实际生效的 profile 名（不传时为默认 profile）。
  local effective_profile="${profile:-$BH_DEFAULT_PROFILE}"

  _bh_write_summary "$url" "$effective_profile" "$profile_path" "$ts" "$ev_dir" \
    "$har" "$xhr_count" "$error_count" "$artifact_errors" >"$ev_dir/summary.json"

  cat "$ev_dir/summary.json"
}

# 从 agent-browser --json 的信封 {"success":true,"data":{...}} 里解包。
# 用法：_bh_unwrap_envelope <data 内的 key，"-" 表示整个 data> <失败 fallback JSON>
# stdin 读信封，stdout 输出解包结果；信封非 success、解析失败或 key 缺失时
# 输出 fallback 并返回 1（调用方记 artifact_errors）。
_bh_unwrap_envelope() {
  node -e '
    const key = process.argv[1];
    const fallback = process.argv[2];
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const v = JSON.parse(raw);
        if (!v || v.success !== true || typeof v.data !== "object" || v.data === null) {
          throw new Error("bad envelope");
        }
        const out = key === "-" ? v.data : v.data[key];
        if (out === undefined) throw new Error("missing key: " + key);
        process.stdout.write(JSON.stringify(out));
      } catch {
        process.stdout.write(fallback);
        process.exit(1);
      }
    });
  ' "$1" "$2"
}

# 用 node 生成 summary.json，避免手拼 JSON 在 url 含引号等场景下损坏。
# argv: url profile profile_dir ts ev_dir har xhr_count error_count errors_csv
_bh_write_summary() {
  node -e '
    const [url, profile, profileDir, ts, evDir, har, xhrCount, errorCount, errorsCsv] =
      process.argv.slice(1);
    const artifacts = {
      screenshot: "screenshot.png",
      dom: "dom.json",
      console: "console.json",
      network_xhr: "network-xhr.json",
      network_errors: "network-errors.json",
    };
    if (har === "1") artifacts.har = "network.har";
    console.log(JSON.stringify({
      target: url,
      profile,
      profile_dir: profileDir,
      timestamp: ts,
      evidence_dir: evDir,
      artifacts,
      counts: { network_xhr: Number(xhrCount), network_errors: Number(errorCount) },
      artifact_errors: errorsCsv ? errorsCsv.split(",") : [],
    }, null, 2));
  ' "$@"
}

_bh_count_json_array() {
  # 不引入 jq；用 node 数组长度兜底；非数组返回 0。
  node -e '
    const fs = require("fs");
    try {
      const v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      console.log(Array.isArray(v) ? v.length : 0);
    } catch { console.log(0); }
  ' "$1" 2>/dev/null || echo 0
}
