# skills/browser-harness/scripts/lib/dev-server.sh
# 起停 dev server。launchctl 防回收策略继承自 browser-operator 时代。
# 公开函数：
#   bh_resolve_dev_command <project_dir>   stdout 输出最终命令字符串
#   bh_dev_server_start <iteration> <project_dir> <dev_command>
#   bh_dev_server_stop <project_dir_abs>       停掉该项目 start 出来的服务

bh_resolve_dev_command() {
  local proj="$1"
  if [ -z "$proj" ] || [ ! -d "$proj" ]; then
    bh_die 2 "项目目录不存在：$proj"
  fi
  if [ ! -f "$proj/package.json" ]; then
    bh_die 2 "目录缺少 package.json：$proj"
  fi

  if [ -n "${INSPECS_DEV_COMMAND:-}" ]; then
    printf '%s\n' "$INSPECS_DEV_COMMAND"
    return 0
  fi

  # 用 node 提取 scripts；不引入 jq 依赖。
  local script
  for script in dev start serve; do
    if node -e '
      const p = require(process.argv[1] + "/package.json");
      process.exit(p && p.scripts && p.scripts[process.argv[2]] ? 0 : 1);
    ' "$proj" "$script" >/dev/null 2>&1; then
      printf 'tnpm run %s\n' "$script"
      return 0
    fi
  done

  bh_die 2 "package.json 里找不到 dev/start/serve 之一；请用 INSPECS_DEV_COMMAND=... 显式指定"
}

# 以下沿用 browser-operator 时代经过踩坑后的 launchctl 路径。
# stdout: APP_URL=... DEV_SERVER_PID=... DEV_SERVER_LOG=...

bh_dev_server_start() {
  local iteration="$1"
  local project_dir="$2"
  local dev_command="$3"

  bh_ensure_log_dir
  local ts dev_log pid_file label_file wrapper_file
  ts="$(date +%s)"
  dev_log="$BH_LOG_DIR/dev-${iteration}-${ts}.log"
  pid_file="$(bh_pid_file "$project_dir")"
  label_file="$(bh_label_file "$project_dir")"
  wrapper_file="$BH_LOG_DIR/dev-${iteration}-${ts}.sh"

  # 已有存活 server 先停掉。
  if [ -f "$pid_file" ]; then
    local old_pid
    old_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "${old_pid:-}" ] && kill -0 "$old_pid" 2>/dev/null; then
      bh_warn "已有 dev server pid $old_pid 仍存活，先停掉"
      bh_dev_server_stop "$project_dir" || true
    fi
  fi

  bh_log "启动 dev：$dev_command"
  bh_log "log: $dev_log"

  local app_host="${INSPECS_APP_HOST:-localhost}"
  local base_path="${BASE_PATH:-/}"
  local curl_no_proxy="${INSPECS_CURL_NO_PROXY:-*}"

  local dev_pid=""
  if [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] && command -v launchctl >/dev/null 2>&1; then
    local sanitized_iter label
    sanitized_iter="$(printf '%s' "$iteration" | tr -c 'A-Za-z0-9_.-' '-')"
    label="com.codex.browser-harness.${sanitized_iter}.${ts}"
    cat >"$wrapper_file" <<EOF
#!/usr/bin/env bash
set -euo pipefail
trap '' HUP
echo "\$\$" > $(bh_shell_quote "$pid_file")
cd $(bh_shell_quote "$project_dir")
exec bash -lc $(bh_shell_quote "$dev_command")
EOF
    chmod +x "$wrapper_file"
    echo "$label" >"$label_file"
    launchctl submit -l "$label" -o "$dev_log" -e "$dev_log" -- "$wrapper_file"

    local i
    for i in $(seq 1 30); do
      dev_pid="$(cat "$pid_file" 2>/dev/null || true)"
      if [ -n "$dev_pid" ] && kill -0 "$dev_pid" 2>/dev/null; then break; fi
      sleep 1
    done
    if [ -z "${dev_pid:-}" ] || ! kill -0 "$dev_pid" 2>/dev/null; then
      tail -n 80 "$dev_log" >&2 || true
      bh_dev_server_stop "$project_dir" || true
      bh_die 2 "launchctl job 没有发布存活 pid"
    fi
  elif command -v setsid >/dev/null 2>&1; then
    setsid nohup bash -lc "cd $(bh_shell_quote "$project_dir") && $dev_command" >"$dev_log" 2>&1 &
    dev_pid=$!
    echo "$dev_pid" >"$pid_file"
  else
    nohup bash -lc "cd $(bh_shell_quote "$project_dir") && $dev_command" >"$dev_log" 2>&1 &
    dev_pid=$!
    echo "$dev_pid" >"$pid_file"
  fi
  bh_log "dev server pid: $dev_pid"

  # 等端口出现在日志里。
  local port=""
  local i
  for i in $(seq 1 60); do
    if ! kill -0 "$dev_pid" 2>/dev/null; then
      tail -n 80 "$dev_log" >&2 || true
      bh_die 2 "dev 进程在打印端口前退出"
    fi
    port="$(grep -Eo 'http://(localhost|127\.0\.0\.1):[0-9]+' "$dev_log" 2>/dev/null \
      | head -n1 | sed -E 's#.*:([0-9]+)#\1#')"
    if [ -n "$port" ]; then break; fi
    sleep 2
  done
  [ -n "$port" ] || { tail -n 80 "$dev_log" >&2 || true; bh_die 2 "等待 dev 端口超时"; }

  local app_url="http://${app_host}:${port}${base_path}"
  local ready_code="000"
  for i in $(seq 1 60); do
    ready_code="$(curl --noproxy "$curl_no_proxy" -s -o /dev/null -w "%{http_code}" "$app_url" 2>/dev/null || true)"
    if ! expr "$ready_code" : '^[0-9][0-9][0-9]$' >/dev/null; then ready_code="000"; fi
    if [ "$ready_code" != "000" ] && [ "$ready_code" -lt 500 ]; then break; fi
    sleep 2
  done
  if [ "$ready_code" = "000" ] || [ "$ready_code" -ge 500 ]; then
    tail -n 80 "$dev_log" >&2 || true
    bh_dev_server_stop "$project_dir" || true
    bh_die 3 "APP_URL $app_url 不可达"
  fi

  bh_log "ready: $app_url (http $ready_code)"
  printf 'APP_URL=%s\n' "$(bh_shell_quote "$app_url")"
  printf 'DEV_SERVER_PID=%s\n' "$(bh_shell_quote "$dev_pid")"
  printf 'DEV_SERVER_LOG=%s\n' "$(bh_shell_quote "$dev_log")"
}

_bh_remove_launchctl_job() {
  local label="$1"
  if [ -n "${label:-}" ] && command -v launchctl >/dev/null 2>&1; then
    launchctl remove "$label" >/dev/null 2>&1 || true
  fi
}

_kill_descendants() {
  local parent="$1" sig="$2" child
  command -v pgrep >/dev/null 2>&1 || return 0
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    _kill_descendants "$child" "$sig"
    kill "-$sig" "$child" 2>/dev/null || true
  done
}

# bh_dev_server_stop <project_dir_abs>：停掉该项目 prepare 出来的 dev server。
bh_dev_server_stop() {
  local project_dir="$1"
  local pid_file label_file
  pid_file="$(bh_pid_file "$project_dir")"
  label_file="$(bh_label_file "$project_dir")"
  local label
  label="$(cat "$label_file" 2>/dev/null || true)"
  rm -f "$label_file"

  if [ ! -f "$pid_file" ]; then
    bh_log "无 pid 文件，跳过"
    _bh_remove_launchctl_job "$label"
    return 0
  fi

  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  rm -f "$pid_file"

  if [ -z "${pid:-}" ]; then
    _bh_remove_launchctl_job "$label"
    return 0
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    bh_log "pid $pid 不存活，跳过"
    _bh_remove_launchctl_job "$label"
    return 0
  fi

  local pgid current_pgid use_pg=0
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
  current_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d ' ')"
  if [ -n "$pgid" ] && [ "$pgid" != "$current_pgid" ]; then
    use_pg=1
    kill -TERM "-$pgid" 2>/dev/null || true
  else
    _kill_descendants "$pid" TERM
  fi
  kill -TERM "$pid" 2>/dev/null || true
  _bh_remove_launchctl_job "$label"

  local i
  for i in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
      bh_log "dev server $pid 已退出"
      return 0
    fi
    sleep 1
  done

  if [ "$use_pg" = "1" ]; then
    kill -KILL "-$pgid" 2>/dev/null || true
  else
    _kill_descendants "$pid" KILL
  fi
  kill -KILL "$pid" 2>/dev/null || true
  bh_log "dev server $pid force-killed"
  return 0
}
