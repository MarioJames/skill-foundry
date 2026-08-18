#!/usr/bin/env python3
"""Discover SSH-related aliases from the user's effective login shell."""

from __future__ import annotations

import json
import os
from pathlib import Path
import pwd
import re
import shlex
import subprocess
import sys
import uuid


SAFE_ALIAS = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")
SSH_COMMAND = re.compile(
    r"^\s*(?:(?:builtin|command|exec)\s+)?(?P<transport>autossh|mosh|ssh)(?:\s|$)"
)


def login_shell() -> Path:
    configured = os.environ.get("SHELL") or pwd.getpwuid(os.getuid()).pw_shell
    shell = Path(configured).expanduser()
    if not shell.is_file():
        raise RuntimeError("the configured login shell is unavailable")
    return shell


def capture_command(shell_name: str, begin: str, end: str) -> str:
    quoted_begin = shlex.quote(begin)
    quoted_end = shlex.quote(end)

    if shell_name == "zsh":
        return f"""
printf '%s\\0' {quoted_begin}
for alias_name in ${{(ok)aliases}}; do
  printf '%s\\0%s\\0' "$alias_name" "$aliases[$alias_name]"
done
printf '%s\\0' {quoted_end}
"""

    if shell_name == "bash":
        return f"""
printf '%s\\0' {quoted_begin}
while IFS= read -r alias_name; do
  printf '%s\\0%s\\0' "$alias_name" "${{BASH_ALIASES[$alias_name]}}"
done < <(printf '%s\\n' "${{!BASH_ALIASES[@]}}" | LC_ALL=C sort)
printf '%s\\0' {quoted_end}
"""

    raise RuntimeError(f"unsupported login shell: {shell_name}")


def effective_aliases(shell: Path) -> list[tuple[str, str]]:
    nonce = uuid.uuid4().hex
    begin = f"__PERSISTENT_SSH_OPS_BEGIN_{nonce}__"
    end = f"__PERSISTENT_SSH_OPS_END_{nonce}__"
    command = capture_command(shell.name, begin, end)
    result = subprocess.run(
        [str(shell), "-lic", command],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    begin_marker = begin.encode() + b"\0"
    end_marker = end.encode() + b"\0"
    start = result.stdout.find(begin_marker)
    stop = result.stdout.find(end_marker, start + len(begin_marker))
    if start < 0 or stop < 0:
        raise RuntimeError("could not read aliases from the effective login shell")

    payload = result.stdout[start + len(begin_marker) : stop]
    fields = payload.split(b"\0")
    if fields and fields[-1] == b"":
        fields.pop()
    if len(fields) % 2:
        raise RuntimeError("the login shell returned an invalid alias stream")

    aliases: list[tuple[str, str]] = []
    for index in range(0, len(fields), 2):
        name = fields[index].decode(errors="replace")
        command_value = fields[index + 1].decode(errors="replace")
        aliases.append((name, command_value))
    return aliases


def main() -> int:
    try:
        shell = login_shell()
        discovered = []
        for name, command in effective_aliases(shell):
            match = SSH_COMMAND.match(command)
            if not match or not SAFE_ALIAS.fullmatch(name):
                continue
            discovered.append(
                {
                    "alias": name,
                    "transport": match.group("transport"),
                    "command": command,
                }
            )

        output = {
            "schema_version": 1,
            "shell": str(shell),
            "host_aliases": sorted(discovered, key=lambda item: item["alias"]),
        }
        json.dump(output, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        return 0
    except (OSError, RuntimeError) as error:
        print(f"scan-hosts: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
