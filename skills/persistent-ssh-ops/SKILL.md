---
name: persistent-ssh-ops
description: Initialize named zsh SSH server profiles and operate user-managed remote servers through one reusable TTY-backed session. Use for local server-profile setup or multi-command server maintenance, logs, deployments, Docker/systemd/nginx/database checks, configuration edits, and incident debugging.
---

# Persistent SSH Ops

## Core rule

Open one TTY-backed SSH session per target host and reuse it for the complete remote workflow. Use local commands only for discovery and preparation; send remote commands through the persistent session.

## Initialize the server profile environment

Run initialization only when the user asks to set up or update the local server profile environment:

```bash
bun <skill-directory>/scripts/init-server-config.ts
```

Resolve the script path relative to this `SKILL.md`. The initializer installs the complete managed runtime at `~/.config/zsh/server-runtime.zsh`, creates `~/.config/zsh/servers.zsh` only when absent, sets their modes to `700` and `600`, and adds ordered source lines to `~/.zshrc`. Re-running updates only the marked managed runtime; it preserves all user profile declarations and refuses to overwrite an unmarked runtime file.

The user profile file accepts one declaration per server:

```zsh
server_define <name> <user> <IP-or-host> <port> '<password-or-empty>'
```

The runtime provides `server_define`, `server_link`, `server_ssh`, a password-free `SERVER_PROFILES` registry, and matching aliases. A non-empty password is supplied through `SSH_ASKPASS`; an empty password uses SSH keys. Never print, scan, copy, or commit password values. Do not run initialization as an incidental prerequisite to ordinary remote work without the user's authorization to change local shell configuration.

## Discover and resolve the target

Before selecting or resolving a target, run the bundled scanner:

```bash
bun <skill-directory>/scripts/scan-hosts.ts
```

Resolve the script path relative to this `SKILL.md`, not the current project directory. The scanner starts the user's configured login shell in login and interactive mode and returns two separately filtered sources:

- `server_profiles`: names and password-free `ssh://` URIs registered by `server_define`;
- `host_aliases`: legacy direct `ssh`, `mosh`, and `autossh` aliases.

Treat both fields as runtime-only local context. Never copy scanner output into the skill, repository, memory, or final report. Prefer an exact `server_profiles[].name` match over a legacy alias with the same name. Never infer or inspect a corresponding `*_PASSWD` variable.

For a registered profile, use only a scanner-returned name matching `^[a-z][a-z0-9_]*$` and start the installed runtime directly:

```bash
"$HOME/.config/zsh/server-runtime.zsh" <exact-profile-name>
```

Do not reconstruct `ssh` from `server_profiles[].uri`; doing so would bypass the profile's password/key behavior. The runtime command must be started with a TTY for a reusable interactive session.

If the requested target is neither a registered profile nor a scanned shell alias, try it as an OpenSSH `Host` alias. Inspect its resolved, non-secret connection shape without connecting:

```bash
ssh -G <host-alias> | sed -n '/^hostname /p; /^user /p; /^port /p; /^proxyjump /p; /^identityfile /p'
```

Report identity-file paths only; never print private-key contents. When the target remains ambiguous after scanning, ask for the host alias. Do not guess from previously used machine names.

For a scanned legacy shell alias, start the exact safe alias name through the same login shell used by the scanner:

```bash
"$SHELL" -lic '<exact-scanned-alias>'
```

Use only a scanner-returned alias matching `^[A-Za-z_][A-Za-z0-9_.-]*$`. Do not use `eval`, do not execute `host_aliases[].command` directly, and do not accept arbitrary shell text as an alias.

## Open and reuse a session

Start the registered profile runtime, resolved OpenSSH alias, or legacy login-shell command above in a TTY-capable execution tool:

```json
{
  "cmd": "ssh <host-alias>",
  "tty": true,
  "yield_time_ms": 1000,
  "max_output_tokens": 12000
}
```

Record `session_id -> host -> current remote directory`, then send every remote command through that session's stdin. Use one persistent session per host when several hosts are in scope.

Establish context immediately:

```bash
printf 'host=%s user=%s cwd=%s\n' "$(hostname)" "$(whoami)" "$PWD"
```

## Remote workflow

Before edits or service changes:

- Inspect current state with project-appropriate commands such as `git status`, `docker ps`, `docker compose ps`, `systemctl status`, `ss -lntp`, and service config tests.
- Resolve the actual config, unit, compose, and deployment paths instead of assuming conventional locations.
- Back up risky configuration before modifying it.
- Preserve unrelated dirty files and live changes.
- Check whether `docker compose` or `docker-compose` is installed before choosing one.

After a change:

- Run native config validation such as `nginx -t`, `xray run -test`, or `docker compose config`.
- Verify service status, listeners, bounded recent logs, and an end-to-end smoke test.
- Reconnect and verify final state if a restart interrupts SSH.

## Command hygiene

- Keep secrets out of commands likely to be echoed, shell history, transcripts, and reports. Prefer protected environment injection or root-owned files with minimum permissions.
- Bound logs and avoid leaving foreground tails or monitors attached.
- Quote heredocs carefully when transferring multi-line configuration.
- Do not expose private keys, tokens, seeds, passwords, connection strings, or unredacted service configuration.
- Treat host-key changes as a security event. Stop and report the mismatch; do not bypass verification with permissive SSH options.

## Close the session

After final verification, send `exit` and confirm the execution session ended. If necessary, send EOF; if a foreground process blocks logout, interrupt only that process, then exit. Leave a session open only when the user explicitly requests it, and report why it remains.

## Reporting

Report the resolved host identity, important files changed, validation commands, concrete outcomes, and whether every SSH session was released. Redact authentication material and secret-bearing values.

## Gotchas

- A local listener or green service status does not prove the service is reachable externally.
- A registered profile must be executed through `server-runtime.zsh`; its URI is discovery metadata, not an executable command.
- A host alias may use `ProxyJump`, a non-default port, or several identity files; inspect `ssh -G` before reproducing the connection manually.
- Repeated one-shot SSH commands lose shell state, current directory, and interactive diagnostics; reuse the TTY for multi-step work.
- Never turn off host-key checking to recover from an unexpected fingerprint change.
