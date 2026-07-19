import shutil
from pathlib import Path

from . import catalog, cleanup, observe, rounds
from .redact import redact_secrets


PROFILE_CONFIGS = {
    "skill": {
        "implemented": True,
        "summary": "staged standalone skill, real CLI task, transcript capture",
    },
    "plugin": {
        "implemented": True,
        "summary": "sandboxed plugin staging, real CLI task, transcript capture",
    },
    "rule": {
        "implemented": False,
        "summary": "rule trigger profile placeholder",
    },
    "agent": {
        "implemented": True,
        "summary": "sandboxed agent staging, real CLI task, transcript capture",
    },
}


def list_profiles() -> list:
    return [
        {"asset_type": name, **config}
        for name, config in sorted(PROFILE_CONFIGS.items())
    ]


def launch_round_for_target(row, cli) -> dict:
    plugin_install = None
    cli_args = ["--add-dir", _source_add_dir(row["asset_source"])]
    if row["asset_type"] in ("plugin", "skill", "agent"):
        if _supports_claude_session_plugins(cli):
            if row["asset_type"] == "plugin":
                plugin_install = observe.install_plugin_source(
                    row["sandbox_path"], row["asset_source"], name=row["asset_name"],
                )
            elif row["asset_type"] == "skill":
                plugin_install = observe.install_skill_source(
                    row["sandbox_path"], row["asset_source"], name=row["asset_name"],
                )
            else:
                plugin_install = observe.install_agent_source(
                    row["sandbox_path"], row["asset_source"], name=row["asset_name"],
                )
            if plugin_install:
                cli_args = [*plugin_install.get("cli_args", []), *cli_args]
        else:
            plugin_install = {
                "installed": False,
                "reason": (
                    "session plugin staging is only supported for Claude CLI; "
                    f"using add-dir fallback for {Path(str(cli)).name}"
                ),
                "asset_type": row["asset_type"],
            }
    launched = observe.launch_round(
        row["round_tag"], row["sandbox_path"], cli, cli_args=cli_args,
    )
    return {
        "plugin_install": plugin_install,
        "cli_args": cli_args,
        **launched,
    }


def run_task(con, acceptance_id, task_key, *, mode, cli,
             wait_seconds=60, capture_start="-2000",
             finalize_verdict=None, next_round_reco=None) -> dict:
    target = catalog.get_acceptance_target(con, acceptance_id)
    if not target:
        raise ValueError(f"acceptance not found: {acceptance_id}")
    config = PROFILE_CONFIGS.get(target["asset_type"])
    if not config:
        raise ValueError(f"unknown asset type: {target['asset_type']}")
    if not config["implemented"]:
        raise NotImplementedError(
            f"profile for asset type {target['asset_type']!r} is not implemented"
        )

    fixture_path = target["fixture_path"]
    if fixture_path and not Path(fixture_path).exists():
        raise ValueError(f"fixture not found: {fixture_path}")
    _validate_task_key(con, acceptance_id, task_key)

    rid = rounds.start_round(con, acceptance_id, mode=mode, n=1)
    rrow = rounds.get_round_target(con, rid)
    sandbox = observe.make_sandbox(rrow["round_tag"])
    fixture_copy = observe.rsync_fixture(fixture_path, sandbox)
    rounds.set_sandbox_path(con, rid, sandbox)

    launch_row = rounds.get_launch_target(con, rid)
    launch = launch_round_for_target(launch_row, cli)
    body = observe.feed_task(con, acceptance_id, task_key, launch["pane"])
    rounds.add_task_key(con, rid, task_key)
    idle_seconds = max(8, wait_seconds // 4)
    observe.wait_for_idle(
        launch["pane"], idle_seconds=idle_seconds,
        max_seconds=wait_seconds,
    )
    prompt_returned = observe.wait_for_prompt(
        launch["pane"], timeout=10,
    )
    transcript = redact_secrets(
        observe.capture_pane(launch["pane"], start=capture_start)
    )
    evidence_dir = Path(sandbox) / ".tmp" / "profile-run"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    transcript_path = evidence_dir / f"{task_key}.transcript.txt"
    transcript_path.write_text(transcript, encoding="utf-8")

    report = (
        f"Profile run ({target['asset_type']}) executed task {task_key}: "
        f"start/launch/feed/capture via scripted spine; "
        f"prompt_returned={prompt_returned}; chars={len(transcript)}."
    )
    rounds.record(con, rid, transcript=transcript, report_append=report)

    result = {
        "profile": target["asset_type"],
        "round": rid,
        "round_tag": rrow["round_tag"],
        "sandbox": str(sandbox),
        "fixture": str(fixture_copy) if fixture_copy else None,
        "task": task_key,
        "task_chars": len(body),
        "prompt_returned": prompt_returned,
        "transcript_chars": len(transcript),
        "transcript_file": str(transcript_path),
        "launch": {
            "session": launch["session"],
            "pane": launch["pane"],
            "existing": launch["existing"],
            "plugin_install": launch.get("plugin_install"),
        },
    }
    if finalize_verdict:
        rounds.finalize(
            con, rid, verdict=finalize_verdict,
            next_round_reco=next_round_reco,
        )
        result["verdict"] = finalize_verdict
        result["cleanup"] = cleanup.cleanup_round(con, rid)
    return result


def _source_add_dir(source_path) -> str:
    src = Path(source_path)
    return str(src if src.is_dir() else src.parent)


def _supports_claude_session_plugins(cli) -> bool:
    return Path(str(cli)).name.startswith("claude")


def _validate_task_key(con, acceptance_id, task_key) -> None:
    prompts = catalog.get_task_prompts(con, acceptance_id)
    if task_key not in prompts:
        raise ValueError(f"task {task_key!r} not found for acceptance {acceptance_id}")


def preflight(cli: str = "claude") -> dict:
    found = shutil.which(cli)
    if not found:
        return {"ok": False, "reason": f"selected CLI {cli!r} not on PATH",
                "cli": cli}
    return {"ok": True, "cli": cli, "resolved": found}
