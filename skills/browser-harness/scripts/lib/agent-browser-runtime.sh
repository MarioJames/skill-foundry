# skills/browser-harness/scripts/lib/agent-browser-runtime.sh
# 检查 agent-browser CLI 是否在 PATH 里、版本是否不低于适配下限。技能不替用户安装。

# 本技能适配的最低版本：0.29 起 --json 统一信封输出、screenshot 位置参数。
BH_MIN_AGENT_BROWSER_VERSION="0.29.0"

bh_require_agent_browser() {
  if ! command -v agent-browser >/dev/null 2>&1; then
    bh_die 2 "未找到 agent-browser CLI；请按 https://github.com/vercel-labs/agent-browser 安装并运行 'agent-browser install' 拉取 Chrome for Testing"
  fi
  # 版本探测失败（老版本输出格式变化等）不阻断，只在能解析且偏低时提醒。
  local ver
  ver="$(agent-browser --version 2>/dev/null | awk '{print $2}')"
  if [ -n "$ver" ] && ! _bh_version_ge "$ver" "$BH_MIN_AGENT_BROWSER_VERSION"; then
    bh_warn "agent-browser $ver 低于技能适配下限 ${BH_MIN_AGENT_BROWSER_VERSION}，证据采集契约（--json 信封 / screenshot 位置参数）可能不匹配；建议执行 agent-browser upgrade"
  fi
  return 0
}

# _bh_version_ge <a> <b>：点分数字版本比较，a >= b 时返回 0。
_bh_version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)" = "$2" ]
}
