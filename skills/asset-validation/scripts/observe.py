import shlex
import subprocess
import time
from pathlib import Path

from . import catalog
from .envprep import (
    cleanup_sandbox as cleanup,
    isolation_env,
    make_sandbox,
    prepare_round_environment,
    rsync_fixture,
)
from .plugin_runtime import cleanup_plugin_install, install_plugin_source


def tmux_new_session(session, cwd, cmd, runner=subprocess.run) -> str:
    runner(
        ["tmux", "new-session", "-d", "-s", session, "-c", str(cwd), cmd],
        check=True,
    )
    return session


def has_session(session, runner=subprocess.run) -> bool:
    try:
        runner(
            ["tmux", "has-session", "-t", session],
            check=True, capture_output=True, text=True,
        )
        return True
    except subprocess.CalledProcessError:
        return False


def _has_settings_arg(args) -> bool:
    return any(arg == "--settings" or str(arg).startswith("--settings=")
               for arg in args)


def _is_claude_cli(cli) -> bool:
    return Path(str(cli)).name.startswith("claude")


def _default_cli_args(cli, env, cli_args=None) -> list:
    args = list(cli_args or [])
    if _is_claude_cli(cli) and not _has_settings_arg(args):
        args = ["--settings", env["CMDAI_CLAUDE_SETTINGS_PATH"], *args]
    return args


def tmux_new_session_env(session, cwd, cli, env, cli_args=None,
                         runner=subprocess.run) -> str:
    assignments = " ".join(
        f"{key}={shlex.quote(str(value))}" for key, value in sorted(env.items())
    )
    args = [str(cli), *[str(arg) for arg in (cli_args or [])]]
    cmd = "env " + assignments + " " + " ".join(shlex.quote(arg) for arg in args)
    return tmux_new_session(session, cwd, cmd, runner=runner)


def session_name(round_tag) -> str:
    """Unique tmux session name per round; never reuse acc-r1-style names
    across concurrent acceptances, and never kill-server."""
    return f"acc-{round_tag}"


def launch_round(round_tag, sandbox, cli, cli_args=None, runner=subprocess.run) -> dict:
    sb = Path(sandbox)
    sb.mkdir(parents=True, exist_ok=True)
    session = session_name(round_tag)
    pane = f"{session}:0.0"
    if has_session(session, runner=runner):
        return {"session": session, "pane": pane, "existing": True}
    env = prepare_round_environment(sb)
    args = _default_cli_args(cli, env, cli_args)
    tmux_new_session_env(session, sb, cli, env, cli_args=args, runner=runner)
    return {"session": session, "pane": pane, "existing": False}


def kill_session(session, runner=subprocess.run) -> bool:
    """Kill only this named session. Never use `tmux kill-server`; on a shared
    server it would destroy every other agent's acceptance session."""
    try:
        runner(["tmux", "kill-session", "-t", session], check=True,
               capture_output=True, text=True)
        return True
    except subprocess.CalledProcessError:
        return False


def feed_task(con, acceptance_id, task_key, pane, runner=subprocess.run,
              ready_timeout=20, ready_settle_delay=3.0,
              submit_delay=0.8, submit_attempts=4,
              resubmit_delay=2.0, paste_attempts=3,
              paste_retry_delay=2.0) -> str:
    prompts = catalog.get_task_prompts(con, acceptance_id)
    if task_key not in prompts:
        raise KeyError(f"task {task_key!r} not found for acceptance {acceptance_id}")
    if not wait_for_prompt(pane, timeout=ready_timeout, runner=runner):
        raise RuntimeError(f"pane did not become ready for input: {pane}")
    if ready_timeout > 0:
        # The first rendered prompt can appear before Claude Code finishes
        # wiring the input box. Give the TUI a short stable window before paste.
        time.sleep(ready_settle_delay)
    body = prompts[task_key]
    # Inject via tmux buffer + bracketed paste so a multi-line body lands as one
    # block. `send-keys -l` would replay each embedded newline as a return key,
    # and an interactive TUI (claude/codex) submits on the first newline, which
    # would chop a multi-line prompt into separate messages. `paste-buffer -p`
    # brackets the paste; only the explicit Enter below submits.
    pasted = False
    for paste_attempt in range(paste_attempts):
        buf = f"acc-task-{task_key}-{int(time.time() * 1000)}-{paste_attempt}"
        runner(["tmux", "set-buffer", "-b", buf, "--", body], check=True)
        runner(["tmux", "paste-buffer", "-p", "-d", "-b", buf, "-t", pane],
               check=True)
        time.sleep(submit_delay)
        if ready_timeout <= 0 or _pane_contains_body(pane, body, runner=runner):
            pasted = True
            break
        if paste_attempt + 1 < paste_attempts:
            runner(["tmux", "send-keys", "-t", pane, "C-u"], check=True)
            time.sleep(paste_retry_delay)
    if not pasted:
        raise RuntimeError(f"task body did not appear in pane after paste: {pane}")
    # Claude Code's TUI acknowledges bracketed paste asynchronously. Submitting
    # too quickly can leave the text in the prompt without sending the turn.
    # In current interactive builds early Enter presses after bracketed paste can
    # be consumed before the turn starts; short pulses make submission reliable.
    for attempt in range(submit_attempts):
        runner(["tmux", "send-keys", "-t", pane, "Enter"], check=True)
        if attempt + 1 < submit_attempts:
            time.sleep(resubmit_delay)
    return body


def capture_pane(pane, *, start="-2000", runner=subprocess.run) -> str:
    out = runner(
        ["tmux", "capture-pane", "-p", "-S", str(start), "-t", pane],
        check=True, capture_output=True, text=True,
    )
    return out.stdout


def wait_for_prompt(pane, *, timeout=20, interval=0.5,
                    runner=subprocess.run) -> bool:
    """Wait until the interactive CLI appears ready for text input."""
    if timeout <= 0:
        return True
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            text = capture_pane(pane, start="-120", runner=runner)
        except subprocess.CalledProcessError:
            text = ""
        if _is_workspace_trust_prompt(text):
            runner(["tmux", "send-keys", "-t", pane, "Enter"], check=True)
            time.sleep(interval)
            continue
        if "❯" in text:
            return True
        time.sleep(interval)
    return False


def _is_workspace_trust_prompt(text) -> bool:
    return (
        "Yes, I trust this folder" in text
        and "Enter to confirm" in text
    )


def _compact_text(text) -> str:
    return "".join(str(text).split())


def _body_marker(body) -> str:
    return _compact_text(body)[:12]


def _pane_contains_body(pane, body, runner=subprocess.run) -> bool:
    marker = _body_marker(body)
    if not marker:
        return True
    try:
        text = capture_pane(pane, start="-120", runner=runner)
    except subprocess.CalledProcessError:
        return False
    return marker in _compact_text(text) or _has_collapsed_paste_marker(text)


def _has_collapsed_paste_marker(text) -> bool:
    return "[Pasted text" in text and "paste again to expand" in text
