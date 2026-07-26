#!/usr/bin/env bash
# skills/browser-harness/scripts/bh.sh
# 单 dispatcher 入口。子命令实现仍在本文件里——shell 函数比再 source 一层简单。
set -u

BH_VERSION="0.3.0"
BH_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

. "$BH_SCRIPT_DIR/lib/common.sh"
. "$BH_SCRIPT_DIR/lib/target-resolve.sh"
. "$BH_SCRIPT_DIR/lib/agent-browser-runtime.sh"
. "$BH_SCRIPT_DIR/lib/dev-server.sh"
. "$BH_SCRIPT_DIR/lib/evidence.sh"

bh_usage() {
  cat <<'EOF' >&2
usage: bh <subcommand> [args]

subcommands:
  prepare <target>                          target = URL | *.html | project dir
  cleanup [project-dir]                     默认 . ；须与 prepare 的项目目录一致
  login <url> [--profile <name>]
  collect-evidence <url> [--profile <n>] [--har]
  profile-dir [name]                        打印 profile 目录路径（供直接调 agent-browser）
  --version
EOF
}

main() {
  local sub="${1:-}"
  case "$sub" in
    ""|-h|--help)
      bh_usage; exit 1 ;;
    --version)
      echo "browser-harness $BH_VERSION"; exit 0 ;;
    prepare)
      shift; bh_cmd_prepare "$@" ;;
    cleanup)
      shift; bh_cmd_cleanup "$@" ;;
    login)
      shift; bh_cmd_login "$@" ;;
    collect-evidence)
      shift; bh_cmd_collect_evidence "$@" ;;
    profile-dir)
      shift; bh_cmd_profile_dir "$@" ;;
    *)
      printf '[bh][error] unknown subcommand: %s\n' "$sub" >&2
      bh_usage
      exit 1 ;;
  esac
}

bh_cmd_prepare() {
  if [ $# -lt 1 ]; then
    bh_die 2 "usage: bh prepare <target>"
  fi
  local target="$1"; shift
  # 任何 target 都需要 agent-browser 可用（后续 collect/login 都靠它）。
  bh_require_agent_browser

  local resolved resolve_ec
  resolved="$(bh_resolve_target "$target")"
  resolve_ec=$?
  if [ "$resolve_ec" -ne 0 ]; then
    exit "$resolve_ec"
  fi
  eval "$resolved"

  case "$BH_TARGET_KIND" in
    url|file)
      printf 'APP_URL=%s\n' "$(bh_shell_quote "$BH_TARGET_URL")"
      ;;
    project)
      local iter dev_command
      iter="${BH_ITERATION:-default}"
      dev_command="$(bh_resolve_dev_command "$BH_TARGET_DIR")"
      bh_dev_server_start "$iter" "$BH_TARGET_DIR" "$dev_command"
      ;;
    *)
      bh_die 2 "未识别的 target kind: $BH_TARGET_KIND"
      ;;
  esac
}

# bh cleanup [project-dir]：默认清理当前目录对应的 dev server。
# 须与 prepare 时的项目目录一致（状态文件按项目路径 key 隔离）。
bh_cmd_cleanup() {
  local dir="${1:-.}"
  [ -d "$dir" ] || bh_die 2 "cleanup 的 project-dir 不存在：$dir"
  local abs
  abs="$(cd "$dir" && pwd)"
  bh_dev_server_stop "$abs"
}

bh_cmd_login() {
  local url="" profile=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) profile="$2"; shift 2 ;;
      -h|--help)
        echo "usage: bh login <url> [--profile <name>]" >&2; exit 1 ;;
      --) shift; break ;;
      -*) bh_die 2 "未知 flag: $1" ;;
      *)
        if [ -z "$url" ]; then url="$1"; else bh_die 2 "意外参数：$1"; fi
        shift ;;
    esac
  done

  [ -n "$url" ] || bh_die 2 "usage: bh login <url> [--profile <name>]"

  bh_require_agent_browser
  # --profile 可选；不传则用默认 profile，登录态默认就持久化。
  local profile_path
  profile_path="$(bh_profile_dir "$profile")"
  mkdir -p "$profile_path"
  bh_log "profile 存储目录：$profile_path"
  bh_log "headed 启动 agent-browser，请在浏览器里完成登录；登录成功后关闭窗口或保持打开均可，profile 会自动持久化"
  agent-browser open "$url" --profile "$profile_path" --headed
}

bh_cmd_collect_evidence() {
  local url="" profile="" har=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) profile="$2"; shift 2 ;;
      --har)     har="1"; shift ;;
      -h|--help)
        echo "usage: bh collect-evidence <url> [--profile <n>] [--har]" >&2; exit 1 ;;
      -*) bh_die 2 "未知 flag: $1" ;;
      *)
        if [ -z "$url" ]; then url="$1"; else bh_die 2 "意外参数：$1"; fi
        shift ;;
    esac
  done

  [ -n "$url" ] || bh_die 2 "usage: bh collect-evidence <url> [--profile <n>] [--har]"

  bh_collect_evidence "$url" "$profile" "$har"
}

# 打印某个 profile 的目录路径到 stdout。C 场景直接调 agent-browser 时，
# 用 --profile "$(bh profile-dir [name])" 即可复用 bh 持久化的登录态，
# 不必记忆技能内部的存储布局。不传 name 则返回默认 profile 目录。
bh_cmd_profile_dir() {
  local name="${1:-}"
  bh_profile_dir "$name"
}

main "$@"
