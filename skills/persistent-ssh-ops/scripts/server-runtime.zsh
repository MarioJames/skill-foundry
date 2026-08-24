#!/usr/bin/env zsh
# Managed by persistent-ssh-ops. Do not store credentials in this file.

# Direct execution is the stable entry point for agents and SSH_ASKPASS.
if [[ "$ZSH_EVAL_CONTEXT" == toplevel ]]; then
  exec zsh -f -c '
    source "$HOME/.config/zsh/server-runtime.zsh"
    [[ -r "$HOME/.config/zsh/servers.zsh" ]] && source "$HOME/.config/zsh/servers.zsh"

    if [[ -n "${SERVER_SSH_ASKPASS_VAR:-}" ]]; then
      if [[ ! "$SERVER_SSH_ASKPASS_VAR" =~ "^[A-Z][A-Z0-9_]*_PASSWD$" ]]; then
        exit 2
      fi
      print -r -- "${(P)SERVER_SSH_ASKPASS_VAR}"
      exit
    fi

    server_ssh "$@"
  ' zsh "$@"
fi

server_define() {
  emulate -L zsh

  if (( $# != 4 && $# != 5 )); then
    echo "Usage: server_define <name> <user> <IP-or-host> <port> [password]" >&2
    return 2
  fi

  local name="${1:l}"
  local user="$2"
  local host="$3"
  local port="$4"
  local passwd="${5:-}"

  if [[ ! "$name" =~ '^[a-z][a-z0-9_]*$' ]]; then
    echo "Server name must start with a lowercase letter and contain only lowercase letters, digits, or underscores: $name" >&2
    return 2
  fi
  if [[ -z "$user" || -z "$host" ]]; then
    echo "Server user and IP/host must not be empty: $name" >&2
    return 2
  fi
  if [[ ! "$port" =~ '^[0-9]+$' ]] || (( port < 1 || port > 65535 )); then
    echo "Server port must be between 1 and 65535: $port" >&2
    return 2
  fi

  local prefix="${(U)name}"
  local uri="ssh://${user}@${host}:${port}"
  typeset -gx "${prefix}_IP=$host"
  typeset -gx "${prefix}_USER=$user"
  typeset -gx "${prefix}_PORT=$port"
  typeset -gx "${prefix}_PASSWD=$passwd"
  typeset -gx "${prefix}_SSH_URI=$uri"
  typeset -gA SERVER_PROFILES
  SERVER_PROFILES[$name]="$uri"

  alias "$name=server_ssh $name"
}

server_link() {
  emulate -L zsh

  local name="${1:-}"
  if [[ ! "$name" =~ '^[a-zA-Z][a-zA-Z0-9_]*$' ]]; then
    echo "Usage: server_link <server-name>" >&2
    return 2
  fi

  local uri_var="${(U)name}_SSH_URI"
  local uri="${(P)uri_var}"
  if [[ -z "$uri" ]]; then
    echo "Server profile not found: $name" >&2
    return 1
  fi

  print -r -- "$uri"
}

server_ssh() {
  emulate -L zsh

  local name="${1:-}"
  if [[ ! "$name" =~ '^[a-zA-Z][a-zA-Z0-9_]*$' ]]; then
    echo "Usage: server_ssh <server-name> [remote-command...]" >&2
    return 2
  fi
  shift

  local prefix="${(U)name}"
  local ip_var="${prefix}_IP"
  local user_var="${prefix}_USER"
  local port_var="${prefix}_PORT"
  local passwd_var="${prefix}_PASSWD"
  local host="${(P)ip_var}"
  local user="${(P)user_var}"
  local port="${(P)port_var}"
  local passwd="${(P)passwd_var}"

  if [[ -z "$host" || -z "$user" || -z "$port" ]]; then
    echo "Server profile not found: $name" >&2
    return 1
  fi

  local -a ssh_args
  ssh_args=(ssh -o StrictHostKeyChecking=accept-new -p "$port" "$user@$host" "$@")

  if [[ -z "$passwd" ]]; then
    command "${ssh_args[@]}"
    return
  fi

  SERVER_SSH_ASKPASS_VAR="$passwd_var" \
    SSH_ASKPASS="$HOME/.config/zsh/server-runtime.zsh" \
    SSH_ASKPASS_REQUIRE=force \
    DISPLAY="${DISPLAY:-server-ssh}" \
    command "${ssh_args[@]}"
}
