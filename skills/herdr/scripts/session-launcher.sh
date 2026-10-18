#!/bin/sh
# Runs inside the systemd scope created by `route-lane.ts --create-session`.
# Usage: session-launcher.sh --op-tag TAG NAME
# Exit 73: the session already exists (registered name or directory).
# Exit 74: existence could not be established. Exit 64: bad arguments.
# Exit 75: the directory this launcher just created was written to by someone else before the server started.
# The session directory is claimed with an atomic mkdir (no -p on the last component), so a concurrent
# creator of the same name loses. The server is forked only while that directory is still empty, its pid is
# printed on stdout, and the launcher exits; the scope lives on with the server.
[ "$#" -eq 3 ] && [ "$1" = "--op-tag" ] || { echo "usage: session-launcher.sh --op-tag TAG NAME" >&2; exit 64; }
name=$3
case $name in
  '' | -* | *[!A-Za-z0-9_-]*) echo "invalid session name" >&2; exit 64 ;;
esac

root=${XDG_CONFIG_HOME:-$HOME/.config}/herdr/sessions
dir=$root/$name
mkdir -p "$root" || { echo "cannot create $root" >&2; exit 74; }
if [ -e "$dir" ] || [ -L "$dir" ]; then
  echo "session directory already exists: $dir" >&2
  exit 73
fi
listed=$(herdr session list --json) || { echo "herdr session list failed" >&2; exit 74; }
if printf '%s' "$listed" | grep -Eq "\"name\"[[:space:]]*:[[:space:]]*\"$name\""; then
  echo "session is already registered: $name" >&2
  exit 73
fi
if ! mkdir "$dir" 2>/dev/null; then
  if [ -e "$dir" ] || [ -L "$dir" ]; then
    echo "session directory was created concurrently: $dir" >&2
    exit 73
  fi
  echo "cannot create $dir" >&2
  exit 74
fi
entries=$(ls -A "$dir") || { echo "cannot list $dir" >&2; exit 74; }
if [ -n "$entries" ]; then
  echo "session directory was written to before the server started: $dir" >&2
  exit 75
fi

# The op tag identifies this call only; the long-lived server must not carry it.
env -u AGENTS_COOPERATION_OP_TAG herdr --session "$name" server </dev/null >/dev/null 2>&1 &
echo "$!"
