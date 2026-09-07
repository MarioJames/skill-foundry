# Local profile setup

Run initialization only when the user asks to set up or update the local server profile environment:

```bash
bun <skill-directory>/scripts/init-server-config.ts
```

Resolve the script path relative to the skill entry `SKILL.md`, one directory above this reference. The initializer installs the complete managed runtime at `~/.config/zsh/server-runtime.zsh`, creates `~/.config/zsh/servers.zsh` only when absent, sets their modes to `700` and `600`, and adds ordered source lines to `~/.zshrc`. Re-running updates only the marked managed runtime; it preserves all user profile declarations and refuses to overwrite an unmarked runtime file.

The user profile file accepts one declaration per server:

```zsh
server_define <name> <user> <IP-or-host> <port> '<password-or-empty>'
```

The runtime provides `server_define`, `server_link`, `server_ssh`, a password-free `SERVER_PROFILES` registry, and matching aliases. A non-empty password is supplied through `SSH_ASKPASS`; an empty password uses SSH keys. Never print, scan, copy, or commit password values. Do not run initialization as an incidental prerequisite to ordinary remote work without the user's authorization to change local shell configuration.
