#!/usr/bin/env python3
"""Launch one process, then exit without retaining child ownership."""

import os
import subprocess
import sys


def main(argv=None):
    command = list(sys.argv[1:] if argv is None else argv)
    if not command:
        raise SystemExit("detached launcher requires a command")
    subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=None,
        stderr=None,
        start_new_session=True,
        close_fds=True,
    )
    # Avoid Popen finalization in this short-lived intermediary. The Worker is
    # deliberately re-parented when this process exits.
    os._exit(0)


if __name__ == "__main__":
    main()
