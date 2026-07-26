# skills/browser-harness/scripts/lib/target-resolve.sh
# 把 user 给的 target 解析成 (kind, url, dir)。
# stdout 输出可 eval 的 BH_TARGET_KIND / BH_TARGET_URL / BH_TARGET_DIR。

bh_resolve_target() {
  local target="${1:-}"
  if [ -z "$target" ]; then
    bh_die 2 "target 不能为空：用法 bh prepare <url|html|project-dir>"
  fi

  case "$target" in
    http://*|https://*)
      printf 'BH_TARGET_KIND=%s\n' url
      printf 'BH_TARGET_URL=%s\n' "$target"
      return 0
      ;;
  esac

  if [ -f "$target" ]; then
    case "$target" in
      *.html|*.HTM|*.htm)
        local abs
        case "$target" in
          /*) abs="$target" ;;
          *)  abs="$(cd "$(dirname "$target")" && pwd)/$(basename "$target")" ;;
        esac
        printf 'BH_TARGET_KIND=%s\n' file
        printf 'BH_TARGET_URL=file://%s\n' "$abs"
        return 0
        ;;
      *)
        bh_die 2 "target 文件不是 .html：$target"
        ;;
    esac
  fi

  if [ -d "$target" ]; then
    if [ ! -f "$target/package.json" ]; then
      bh_die 2 "target 目录缺少 package.json：$target"
    fi
    local abs
    case "$target" in
      /*) abs="$target" ;;
      *)  abs="$(cd "$target" && pwd)" ;;
    esac
    printf 'BH_TARGET_KIND=%s\n' project
    printf 'BH_TARGET_DIR=%s\n' "$abs"
    return 0
  fi

  bh_die 2 "target 不是 URL、.html 或项目目录：$target"
}
