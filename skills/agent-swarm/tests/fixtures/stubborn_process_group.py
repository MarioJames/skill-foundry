#!/usr/bin/env python3
"""Process group whose leader exits on TERM while a descendant ignores TERM."""

import argparse
import os
import pathlib
import signal
import subprocess
import sys
import time


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--child", action="store_true")
    parser.add_argument("--pid-file")
    args = parser.parse_args(argv)
    if args.child:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        while True:
            time.sleep(1)
    child = subprocess.Popen(
        [sys.executable, __file__, "--child"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    pathlib.Path(args.pid_file).write_text(str(child.pid))
    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()
