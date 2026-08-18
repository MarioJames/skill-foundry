---
name: persistent-ssh-ops
description: Operate user-managed remote servers through one reusable TTY-backed SSH session. Use for multi-command server maintenance, logs, deployments, Docker/systemd/nginx/database checks, configuration edits, incident debugging, or any remote workflow where reconnecting for every command would lose context.
---

# Persistent SSH Ops

## Core rule

Open one TTY-backed SSH session per target host and reuse it for the complete remote workflow. Use local commands only for discovery and preparation; send remote commands through the persistent session.

## Discover and resolve the target

Before selecting or resolving a target, run the bundled scanner:

```bash
python3 <skill-directory>/scripts/scan-hosts.py
```

Resolve the script path relative to this `SKILL.md`, not the current project directory. The scanner starts the user's configured login shell in login and interactive mode, reads the aliases effective in that shell, filters direct `ssh`, `mosh`, and `autossh` commands, and returns JSON to the model. It requires no alias-file path or environment-variable configuration.

Treat `host_aliases[].command` as runtime-only local context. Never copy the scan output into the skill, repository, memory, or final report. Select only an exact `host_aliases[].alias` value and never interpolate the returned command string into another shell command.

If the requested target is not a scanned shell alias, try it as an OpenSSH `Host` alias. Inspect its resolved, non-secret connection shape without connecting:

```bash
ssh -G <host-alias> | sed -n '/^hostname /p; /^user /p; /^port /p; /^proxyjump /p; /^identityfile /p'
```

Report identity-file paths only; never print private-key contents. When the target remains ambiguous after scanning, ask for the host alias. Do not guess from previously used machine names.

For a scanned shell alias, start the exact safe alias name through the same login shell used by the scanner:

```bash
"$SHELL" -lic '<exact-scanned-alias>'
```

Use only a scanner-returned alias matching `^[A-Za-z_][A-Za-z0-9_.-]*$`. Do not use `eval`, do not execute `host_aliases[].command` directly, and do not accept arbitrary shell text as an alias.

## Open and reuse a session

Start the resolved OpenSSH alias or the login-shell command above in a TTY-capable execution tool:

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
- A host alias may use `ProxyJump`, a non-default port, or several identity files; inspect `ssh -G` before reproducing the connection manually.
- Repeated one-shot SSH commands lose shell state, current directory, and interactive diagnostics; reuse the TTY for multi-step work.
- Never turn off host-key checking to recover from an unexpected fingerprint change.
