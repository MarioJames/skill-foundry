# User-managed SSH server profiles. This file may contain secrets; keep mode 600.

if (( ! ${+functions[server_define]} )); then
  if [[ ! -r "$HOME/.config/zsh/server-runtime.zsh" ]]; then
    echo "Missing SSH server runtime: $HOME/.config/zsh/server-runtime.zsh" >&2
    return 1
  fi
  source "$HOME/.config/zsh/server-runtime.zsh"
fi

# server_define arguments:
#   1. name: used by server_ssh, server_link, and the generated alias
#   2. user: remote login user
#   3. IP or host: remote server address
#   4. port: SSH service port
#   5. password: non-empty uses SSH_ASKPASS; an empty string uses SSH keys

# Password login example:
# server_define examplehost ubuntu 203.0.113.10 22 'replace-with-password'

# SSH key example:
# server_define keyhost ubuntu 203.0.113.11 22 ''
