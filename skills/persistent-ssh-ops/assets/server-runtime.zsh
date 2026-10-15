#!/usr/bin/env zsh
# Managed by persistent-ssh-ops. Do not store credentials in this file.

# Suppress aliases while parsing this file, including profiles named local,
# command or server_ssh. Restore the caller's option after loading.
\builtin typeset -g _SERVER_ALIASES_OPTION="${options[aliases]}"
\builtin setopt noaliases

# Resolve this asset when sourced as well as when invoked as SSH_ASKPASS.
typeset -g _SERVER_RUNTIME_PATH="${${(%):-%x}:A}"

_server_config_read() {
  emulate -L zsh
  local mode="$1"
  shift
  [[ -f "$HOME/.config/zsh/servers.json" && -r "$HOME/.config/zsh/servers.json" ]] || return 1
  command jq --stream --slurp --raw-output0 --arg mode "$mode" --arg home "$HOME" \
    "$@" -f "${_SERVER_RUNTIME_PATH:h}/server-config.jq" \
    "$HOME/.config/zsh/servers.json" 2>/dev/null
}

# No aliases, registry or password variables are created on this path.
if [[ "$ZSH_EVAL_CONTEXT" == toplevel && "${SERVER_SSH_ASKPASS:-}" == 1 ]]; then
  [[ $# == 1 && -n "${SERVER_SSH_PROFILE:-}" && -n "${SERVER_SSH_PROMPT_USER:-}" && -n "${SERVER_SSH_PROMPT_HOST:-}" ]] || exit 1
  [[ "$1" == "${SERVER_SSH_PROMPT_USER}@${SERVER_SSH_PROMPT_HOST}'s password: " ]] || exit 1
  # One parse validates the entire document, compares the connection binding,
  # and sends the password straight to SSH, never through a shell variable.
  command jq --stream --slurp --raw-output --exit-status \
    --arg mode askpass --arg home "$HOME" --arg name "$SERVER_SSH_PROFILE" \
    --arg user "${SERVER_SSH_USER:-}" --arg host "${SERVER_SSH_HOST:-}" \
    --arg port "${SERVER_SSH_PORT:-}" --arg identity "${SERVER_SSH_IDENTITY_FILE:-}" \
    -f "${_SERVER_RUNTIME_PATH:h}/server-config.jq" \
    "$HOME/.config/zsh/servers.json" 2>/dev/null
  exit $?
fi

function server_link {
  emulate -L zsh
  local name="${1:-}"
  [[ "$name" =~ '^[a-z][a-z0-9_]*$' ]] || { print -u2 -- 'Usage: server_link <server-name>'; return 2; }
  [[ -n "${SERVER_PROFILES[$name]:-}" ]] || { print -u2 -- 'Server profile not found'; return 1; }
  print -r -- "$SERVER_PROFILES[$name]"
}

function server_ssh {
  emulate -L zsh
  local name="${1:-}"
  [[ "$name" =~ '^[a-z][a-z0-9_]*$' ]] || { print -u2 -- 'Usage: server_ssh <server-name> [remote-command...]'; return 2; }
  shift
  local output
  output=$(_server_config_read connect --arg name "$name") || {
    print -u2 -- 'Server configuration unavailable or invalid (requires jq 1.7+)'; return 1
  }
  local -a fields args
  fields=("${(@0)output}")
  [[ $#fields == 9 && "$fields[1]" == server-config-v1 && "$fields[2]" == "$name" && "$fields[8]" == end && -z "$fields[9]" ]] || {
    print -u2 -- 'Invalid server configuration protocol'; return 1
  }
  local user="$fields[3]" host="$fields[4]" port="$fields[5]" identity="$fields[6]" has_password="$fields[7]"
  args=(-o StrictHostKeyChecking=accept-new -p "$port")
  if [[ -n "$identity" ]]; then
    [[ -f "$identity" && -r "$identity" ]] || { print -u2 -- 'Explicit identity file is unavailable'; return 1; }
    # OpenSSH expands this environment value once, without reinterpreting any
    # percent/dollar characters in the actual path. -i would stat then expand.
    args+=(-o 'IdentityFile=${SERVER_SSH_IDENTITY_FILE}' -o IdentitiesOnly=yes)
  fi
  if [[ "$has_password" == false ]]; then
    SERVER_SSH_IDENTITY_FILE="$identity" command ssh "${args[@]}" -- "$user@$host" "$@"
    return
  fi
  args+=(-o KbdInteractiveAuthentication=no)
  local resolved line key value prompt_user='' prompt_host='' host_key_alias='' proxy_jump='' proxy_command=''
  resolved=$(SERVER_SSH_IDENTITY_FILE="$identity" command ssh -G "${args[@]}" -- "$user@$host" "$@" 2>/dev/null) || {
    print -u2 -- 'Unable to resolve SSH connection'; return 1
  }
  for line in "${(@f)resolved}"; do
    key="${line%% *}"; value="${line#* }"
    case "$key" in
      user) prompt_user="$value" ;;
      hostname) prompt_host="$value" ;;
      hostkeyalias) host_key_alias="$value" ;;
      proxyjump) proxy_jump="$value" ;;
      proxycommand) proxy_command="$value" ;;
    esac
  done
  [[ -n "$prompt_user" && -n "$prompt_host" ]] || { print -u2 -- 'Invalid SSH connection output'; return 1; }
  if [[ ( -n "$proxy_jump" && "$proxy_jump" != none ) || ( -n "$proxy_command" && "$proxy_command" != none ) ]]; then
    print -u2 -- 'Automatic JSON password authentication is unavailable with SSH proxies'; return 1
  fi
  [[ -n "$host_key_alias" ]] && prompt_host="$host_key_alias"
  SERVER_SSH_ASKPASS=1 SERVER_SSH_PROFILE="$name" \
    SERVER_SSH_USER="$user" SERVER_SSH_HOST="$host" SERVER_SSH_PORT="$port" \
    SERVER_SSH_IDENTITY_FILE="$identity" \
    SERVER_SSH_PROMPT_USER="$prompt_user" SERVER_SSH_PROMPT_HOST="$prompt_host" \
    SSH_ASKPASS="$_SERVER_RUNTIME_PATH" SSH_ASKPASS_REQUIRE=force DISPLAY="${DISPLAY:-server-ssh}" \
    command ssh "${args[@]}" -- "$user@$host" "$@"
}

_server_profiles_load() {
  emulate -L zsh
  local name output host uri
  (( ${+_SERVER_PROFILE_ALIASES} )) || typeset -gA _SERVER_PROFILE_ALIASES=()
  # Remove only aliases still owned by this runtime; preserve user replacements.
  for name in "${(@k)_SERVER_PROFILE_ALIASES}"; do
    [[ "${aliases[$name]:-}" == "${_SERVER_PROFILE_ALIASES[$name]}" ]] && unalias -- "$name"
  done
  typeset -gA _SERVER_PROFILE_ALIASES=() SERVER_PROFILES=()
  typeset -g SERVER_PROFILES_STATUS=error SERVER_PROFILES_REASON=invalid_configuration
  # A dangling symlink is an unreadable configuration, not a missing one.
  if [[ ! -e "$HOME/.config/zsh/servers.json" && ! -L "$HOME/.config/zsh/servers.json" ]]; then
    local ancestor="$HOME/.config/zsh"
    while [[ ! -e "$ancestor" && ! -L "$ancestor" && "$ancestor" != / ]]; do
      ancestor="${ancestor:h}"
    done
    if [[ -d "$ancestor" && -x "$ancestor" ]]; then
      SERVER_PROFILES_STATUS=missing; SERVER_PROFILES_REASON=absent
      return 0
    fi
    print -u2 -- 'Server configuration path is inaccessible'
    return 1
  fi
  if ! (( $+commands[jq] )); then
    SERVER_PROFILES_REASON=jq_required
    print -u2 -- 'Server profiles require jq 1.7+; install it before loading the runtime'
    return 1
  fi
  output=$(_server_config_read profiles) || {
    print -u2 -- 'Server configuration is unreadable or invalid'; return 1
  }
  local -a fields
  fields=("${(@0)output}")
  (( $#fields >= 3 && ($#fields - 3) % 6 == 0 )) && \
    [[ "$fields[1]" == server-config-v1 && "$fields[-2]" == end && -z "$fields[-1]" ]] || {
    print -u2 -- 'Invalid server configuration protocol'; return 1
  }
  # Commit registrations only after the producer succeeded and the complete
  # envelope and all records have been checked.
  local -i index
  for (( index=2; index <= $#fields-2; index+=6 )); do
    name="$fields[$index]"
    [[ "$name" =~ '^[a-z][a-z0-9_]*$' ]] || return 1
  done
  for (( index=2; index <= $#fields-2; index+=6 )); do
    name="$fields[$index]"; host="$fields[$((index+2))]"
    [[ "$host" == *:* && "$host" != \[*\] ]] && host="[$host]"
    uri="ssh://$fields[$((index+1))]@$host:$fields[$((index+3))]"
    SERVER_PROFILES[$name]="$uri"
    _SERVER_PROFILE_ALIASES[$name]="server_ssh $name"
    alias "$name=server_ssh $name"
  done
  SERVER_PROFILES_STATUS=ok; SERVER_PROFILES_REASON=none
}

if [[ "$ZSH_EVAL_CONTEXT" == toplevel ]]; then
  \server_ssh "$@"
  exit $?
fi
_server_profiles_load
typeset -g _SERVER_LOAD_RESULT=$?
[[ "$_SERVER_ALIASES_OPTION" == on ]] && setopt aliases
\builtin return $_SERVER_LOAD_RESULT
