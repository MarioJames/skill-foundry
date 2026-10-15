# Local profile setup

Run initialization only when the user asks to set up or update the local server profile environment:

```bash
bun <skill-directory>/scripts/init-server-config.ts
```

Resolve the script path relative to `SKILL.md`, one directory above this reference. Requires zsh and jq 1.7+ (`--raw-output0`); initialization never installs dependencies. The initializer validates existing JSON before writing anything, installs `~/.config/zsh/server-runtime.zsh` and its adjacent shared `server-config.jq`, creates `~/.config/zsh/servers.json` with `{"servers":{}}` only when absent, and ensures the runtime source line exists in `~/.zshrc`. Runtime and validator have mode `700`, JSON `600`. Re-running preserves valid user JSON and refuses to overwrite an unmarked runtime. Installation uses ordinary sequential writes; a later filesystem failure can leave earlier writes in place.

Profiles are data in a single JSON document:

```json
{
  "servers": {
    "example": {
      "user": "ubuntu",
      "host": "example.invalid",
      "port": 22,
      "identity_file": "/absolute/path/example-key"
    }
  }
}
```

The root accepts only `servers`, an object. Names match `^[a-z][a-z0-9_]*$`. Each profile accepts only these fields:

- `user` and `host`: required strings. User names contain letters, digits, underscore, dot or hyphen and start with a letter, digit or underscore. Hosts are DNS names, IPv4, or bracketed/bare IPv6; shell syntax and control characters are rejected.
- `port`: optional integer from 1 through 65535; default `22`.
- `identity_file`: optional nonempty absolute or `~/` path without control characters. The runtime expands `~/` and normalizes `.`/`..` before checking that the resulting path is a readable regular file. The exact checked path is passed through a per-invocation, non-secret environment binding to OpenSSH's controlled `IdentityFile` option; percent tokens and `${...}` within that path are literal filename characters.
- `password`: optional string; omitted or empty means key authentication. NUL, CR and LF are forbidden. Store a password only in the private local JSON, never in a command, repository, skill, scanner output or report.

Unknown fields, duplicate keys at any object level, multiple documents and invalid fields in any profile reject the entire configuration. Loading, connection, askpass and initialization use the same validator. Errors are fixed, redacted messages. Empty `servers` is valid; absent JSON is `missing`; empty, unreadable or damaged JSON is an error. Reloading clears prior registrations and removes only aliases still owned by the runtime.

The runtime provides `server_link`, `server_ssh`, the password-free `SERVER_PROFILES` registry and matching aliases. Start a named profile through the installed executable:

```bash
"$HOME/.config/zsh/server-runtime.zsh" example
```

Connections reread and validate the whole JSON. Explicit missing, non-file or unreadable identities stop before SSH starts. `IdentityFile` entries in SSH configuration still accumulate; `IdentitiesOnly=yes` does not restrict authentication to one file. Unlock encrypted keys with `ssh-add` before using automatic password authentication.

A nonempty JSON password enables `SSH_ASKPASS` only for that invocation and disables keyboard-interactive authentication. The runtime resolves effective SSH settings with `ssh -G` and refuses automatic JSON password supply if ProxyJump or ProxyCommand is active; it never bypasses a configured proxy. Key mode retains ordinary proxy behavior. Other authentication ordering follows OpenSSH configuration.

Askpass matches the full ordinary account-password prompt, including the final space, using effective user and HostKeyAlias (or HostName). It rejects private-key passphrases, OTP, password changes, host-key confirmation and unknown prompts. One parse validates the whole document, compares the original profile/user/host/port/normalized-identity binding, and writes the password only to SSH's askpass channel. Changes to that binding require a new connection.

Prompt and identity expansion behavior has been verified with Linux OpenSSH 10.0p2, official [password prompt implementation](https://github.com/openssh/openssh-portable/blob/V_10_0_P2/sshconnect2.c#L1035-L1050) and [single-pass expansion implementation](https://github.com/openssh/openssh-portable/blob/V_10_0_P2/misc.c#L1322-L1385), and a controlled local server. Other clients, including macOS, have not been verified; differing prompts fail without password output.

The runtime places `--` before the destination, so subsequent `-o` arguments belong to the remote command. Remote command arguments retain OpenSSH's normal command-string semantics; local argv boundaries are not a promise of remote process argv boundaries. Ordinary remote work must use existing profiles without incidental initialization.
