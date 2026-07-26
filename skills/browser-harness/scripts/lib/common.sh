# skills/browser-harness/scripts/lib/common.sh
# log/die 工具 + 共享路径常量。dispatcher 和子模块都 source 它。
# 注意：所有日志走 stderr；stdout 留给可 eval 的 KEY=value。

BH_LOG_DIR="${BH_LOG_DIR:-/tmp/browser-harness}"

# dev server 状态文件按项目目录隔离，避免并行会话（多 worktree / ultra-team）互踢。
# key 是项目物理绝对路径的 cksum 短哈希；同一项目重复 prepare 仍保持单例。
# 先 cd && pwd -P 归一（尾斜杠 / 双斜杠 / 软链都收敛到同一 key），
# 否则 prepare（target-resolve 原样透传的绝对路径）和 cleanup（cd && pwd 归一）
# 会各算各的 key，cleanup 静默 no-op、dev server 泄漏。
# 目录已不存在时退回原始字符串，同一入参仍可算出稳定 key。
bh_project_key() {
  local dir
  dir="$(cd "$1" 2>/dev/null && pwd -P || printf '%s' "$1")"
  printf '%s' "$dir" | cksum | awk '{print $1}'
}

bh_pid_file() {
  printf '%s/dev-%s.pid\n' "$BH_LOG_DIR" "$(bh_project_key "$1")"
}

bh_label_file() {
  printf '%s/dev-%s.label\n' "$BH_LOG_DIR" "$(bh_project_key "$1")"
}

# 技能私有的 profile 存储根目录。把 agent-browser 的登录态收进 $HOME 下
# 一个隐藏目录，避免和系统 Chrome profile 撞名、也方便统一清理。
BH_PROFILE_ROOT="${BH_PROFILE_ROOT:-$HOME/.browser-harness/profiles}"

# 默认 profile 名。--profile 不传时各命令都用它，保证浏览器状态默认就持久化，
# 调用方不必每次记/找之前用的路径。
BH_DEFAULT_PROFILE="${BH_DEFAULT_PROFILE:-default}"

bh_log() {
  printf '[bh] %s\n' "$*" >&2
}

bh_warn() {
  printf '[bh][warn] %s\n' "$*" >&2
}

bh_die() {
  local code="$1"; shift
  printf '[bh][error] %s\n' "$*" >&2
  exit "$code"
}

bh_shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

bh_ensure_log_dir() {
  mkdir -p "$BH_LOG_DIR"
}

# 把 profile 名解析成技能私有隐藏目录下的绝对路径。
# agent-browser 的 --profile 接受名字或路径；统一传路径，保证 login 写入
# 和 collect-evidence 读取指向同一目录、可跨调用复用登录态。
# 不传名字（或空）时回退到 BH_DEFAULT_PROFILE，使浏览器状态默认就持久。
# 已经是路径（含 / 或以 ~ 开头）的入参原样返回，给高级用户留口子。
bh_profile_dir() {
  local name="${1:-}"
  [ -n "$name" ] || name="$BH_DEFAULT_PROFILE"
  case "$name" in
    */*|'~'*) printf '%s\n' "$name" ;;
    *)        printf '%s/%s\n' "$BH_PROFILE_ROOT" "$name" ;;
  esac
}
