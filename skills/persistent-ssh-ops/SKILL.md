---
name: persistent-ssh-ops
description: 通过可复用的 TTY SSH 会话操作远程服务器；用于远程维护、部署、排障和多步验证，按请求初始化本地命名主机配置。
---

# Persistent SSH Ops

Open one TTY-backed SSH session per target host and reuse it for the whole remote workflow: one-shot SSH commands lose shell state, the current directory and interactive diagnostics. Local commands are only for discovery and preparation.

## Resolve the target

```bash
bun <skill-dir>/scripts/scan-hosts.ts --target <name>    # the exact command to start
bun <skill-dir>/scripts/scan-hosts.ts                    # list profiles and aliases when the name is unknown
```

- Start the returned `command` verbatim in a TTY. Do not rebuild `ssh` from a profile URI (that bypasses the profile's password or key handling), run an alias's expansion directly, or `eval` anything.
- `kind: "openssh"` carries the host's non-secret `shape`: hostname, user, port, ProxyJump and identity-file paths. A `note` means no Host entry matches the name: confirm the host with the user instead of guessing from machines used before.
- Scanner output is runtime-only local context. Never copy it into the skill, a repository, memory or the final report, and never inspect stored passwords.
- A nonzero exit (invalid configuration, runtime not loaded, failing login shell) is an error, not an empty host list.
- Initialize or change local profiles only when the user asks, following [profile-setup.md](references/profile-setup.md). Registered profiles need `zsh` and `jq` 1.7+; installing zsh or changing the login shell requires authorization.

## Work in the session

```json
{ "cmd": "<command from scan-hosts>", "tty": true, "yield_time_ms": 1000, "max_output_tokens": 12000 }
```

- Record `session_id -> host -> current directory` and send every remote command through that session's stdin, one session per host. Start with `printf 'host=%s user=%s cwd=%s\n' "$(hostname)" "$(whoami)" "$PWD"`.
- Before changing anything, find the real config, unit, compose and deployment paths rather than assuming conventional ones, and back up risky configuration. Preserve unrelated dirty files and live changes.
- After a change, run the service's own config check, then verify status, listeners, bounded recent logs and an end-to-end request. A local listener or a green status does not prove external reachability. Reconnect and verify again if a restart drops SSH.
- Keep secrets out of echoed commands, shell history and reports. Bound logs and do not leave a foreground tail attached.
- A host-key change is a security event: stop and report it. Never disable host-key checking.

## Close and report

After final verification send `exit` and confirm the session ended; if a foreground process blocks logout, interrupt only that process. Leave a session open only when the user asks, and say why. Report the resolved host, the files changed, the validation commands and their outcomes, and that every session was released, with authentication material redacted.

## Gotchas

- JSON password authentication disables keyboard-interactive and refuses ProxyJump or ProxyCommand connections; key authentication keeps proxy support. See [profile-setup.md](references/profile-setup.md).
- `systemctl show -p LoadCredential` can print `[unprintable]` even as root. That does not mean the credential is missing. Get the unit's object path with `busctl --json=short call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager GetUnit s <unit>`, then read `busctl --json=short get-property org.freedesktop.systemd1 <object-path> org.freedesktop.systemd1.Service LoadCredential` and check the `type` and `data` tuples. Do not log credential contents.
