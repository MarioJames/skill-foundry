import pathlib
import textwrap

import state_store


RECOVERY_KEYWORDS = ("恢复", "接续", "续跑", "recover", "resume")


def has_recovery_intent(text: str) -> bool:
    lowered = (text or "").lower()
    return any(keyword in lowered for keyword in RECOVERY_KEYWORDS)


def infer_intent(task: str, limit: int = 140) -> str:
    text = task_text(task)
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        line = line.lstrip("#").strip()
        if is_boilerplate_intent(line):
            continue
        return line[:limit]
    return (text or "").strip()[:limit]


def task_text(text: str) -> str:
    marker = "[TASK]"
    if marker in (text or ""):
        return text.split(marker, 1)[1].strip()
    return text or ""


def is_boilerplate_intent(line: str) -> bool:
    stripped = (line or "").strip()
    if not stripped:
        return True
    return (
        stripped.startswith("You are")
        or stripped.startswith("Working directory")
        or "Working directory:" in stripped
        or stripped == "ultra team"
        or stripped == "ultra-team"
        or stripped.startswith("[ORCHESTRATION IDENTITY]")
        or stripped.startswith("[DISPATCH DISCIPLINE]")
    )


def normalize_intents(tasks, intents):
    if intents is None:
        return [infer_intent(task) for task in tasks]
    if len(intents) != len(tasks):
        raise SystemExit("--intent count must match --task/--task-stdin count")
    return intents


def discover_recovery_run(cwd: str, current_branch=None, root_id=None):
    if root_id:
        run = state_store.get_run(root_id)
        if not run:
            return {
                "recoverable": False,
                "reason": "root_not_found",
                "root_id": root_id,
                "current_branch": current_branch,
                "same_cwd_running_runs": [],
                "other_branch_runs": [],
            }
        if run.get("status") != "running":
            return {
                "recoverable": False,
                "reason": "root_not_running",
                "root_id": root_id,
                "run": compact_run(run),
                "current_branch": current_branch,
                "same_cwd_running_runs": [],
                "other_branch_runs": [],
            }
        return {
            "recoverable": True,
            "reason": "explicit_root",
            "run": compact_run(run),
            "current_branch": current_branch,
            "same_cwd_running_runs": [compact_run(run)],
            "other_branch_runs": [],
        }

    runs = sorted(
        [run for run in state_store.runs_for_cwd(cwd) if run.get("status") == "running"],
        key=lambda run: run.get("created_at") or 0,
        reverse=True,
    )
    branch_matches = [run for run in runs if (run.get("branch") or "") == (current_branch or "")]
    other_branch_runs = [run for run in runs if (run.get("branch") or "") != (current_branch or "")]
    if branch_matches:
        return {
            "recoverable": True,
            "reason": "current_branch_running_run",
            "run": compact_run(branch_matches[0]),
            "current_branch": current_branch,
            "same_cwd_running_runs": [compact_run(run) for run in branch_matches],
            "other_branch_runs": [compact_run(run) for run in other_branch_runs],
        }
    if other_branch_runs:
        return {
            "recoverable": False,
            "reason": "no_current_branch_running_run",
            "message": "switch branch to one of other_branch_runs or pass --root-id explicitly",
            "current_branch": current_branch,
            "same_cwd_running_runs": [],
            "other_branch_runs": [compact_run(run) for run in other_branch_runs],
        }
    return {
        "recoverable": False,
        "reason": "no_running_run_for_cwd",
        "current_branch": current_branch,
        "same_cwd_running_runs": [],
        "other_branch_runs": [],
    }


def compact_run(run):
    return {
        "root_id": run.get("root_id"),
        "task": run.get("task"),
        "cwd": run.get("cwd"),
        "branch": run.get("branch"),
        "status": run.get("status"),
        "created_at": run.get("created_at"),
    }


def build_recovery_prompt(root_id: str, skill_dir_path: str) -> str:
    tree = state_store.get_tree(root_id)
    run = tree.get("run")
    if not run:
        raise SystemExit(f"run {root_id} does not exist")
    protocol_path = pathlib.Path(skill_dir_path) / "references" / "recovery-protocol.md"
    script_path = pathlib.Path(skill_dir_path) / "scripts" / "agent_orchestrator.py"
    lines = [
        "ultra team",
        "",
        "[RECOVERY CONTEXT] You are the recovered root agent. This is NOT a new-task init; you are resuming an existing ultra-team run on its existing site.",
        f"[RECOVERY PROTOCOL] First read and strictly follow {protocol_path}. Do NOT call init, do NOT create a new root run.",
        "",
        "[RECOVERY TARGET]",
        f"- root_id: {run['root_id']}",
        f"- cwd: {run['cwd']}",
        f"- branch: {run.get('branch') or ''}",
        f"- run_status: {run['status']}",
        f"- original task: {run.get('task') or ''}",
        "",
        "[MUST DO]",
        f"1. First run: python3 {script_path} status --root-id {run['root_id']} --json",
        "2. Consume the historical child-agent intents, statuses, results, and caveats below to judge what work is done, what still needs waiting, and what needs re-splitting into rounds.",
        "3. If there are running direct children, immediately run the corresponding round's await-round; if await-round returns recover_idle_agent, recover the idle or stale busy background agent per the returned command; busy recovery sends Ctrl+C first, then continue.",
        "4. The recovery root handles only its own direct children; historical grandchildren or deeper stale running states cannot be stop/cleaned by root, unless they again become a direct parent's recovery context.",
        "5. The recovery root only handles orchestration, state judgment, and a little wiring observation; once child history exists, do NOT modify business files directly to address review/fix findings.",
        "6. If review returns needs_fix, or historical results are insufficient to prove completion, you MUST dispatch --kind fix or dispatch --kind implement to handle it, then await-round, then re-dispatch --kind review.",
        "7. The body written to dispatch --task or --task-stdin may only contain business task details; do NOT write the ultra team trigger phrase, [ORCHESTRATION IDENTITY], [DISPATCH DISCIPLINE], or agent_id/root_id placeholder blocks — the identity is wrapped automatically by dispatch.",
        "8. After reaching a judgment, you MUST run the corresponding command; do NOT just narrate \"should keep waiting / should review again / should dispatch fix\" and then stop.",
        "9. Before finish you MUST still satisfy the main protocol's review closeout gate.",
        "",
        "[HISTORICAL AGENT TREE: listed top-down from root]",
    ]
    agents = tree.get("agents") or []
    by_parent = {}
    for agent in agents:
        by_parent.setdefault(agent.get("parent_id"), []).append(agent)
    for child in by_parent.get(None, []):
        append_agent(lines, child, by_parent, depth=0)
    return "\n".join(lines).rstrip() + "\n"


def append_agent(lines, agent, by_parent, depth: int):
    indent = "  " * depth
    fields = [
        f"agent_id={agent.get('agent_id')}",
        f"kind={agent.get('kind')}",
        f"round={agent.get('round')}",
        f"status={agent.get('status')}",
        f"job_id={agent.get('job_id') or ''}",
        f"session_id={agent.get('session_id') or ''}",
    ]
    lines.append(f"{indent}- " + " ".join(fields))
    detail_indent = indent + "  "
    lines.append(f"{detail_indent}intent: {one_line(readable_intent(agent))}")
    if agent.get("result"):
        lines.append(f"{detail_indent}result: {block(agent.get('result'))}")
    if agent.get("caveats"):
        lines.append(f"{detail_indent}caveats: {block(agent.get('caveats'))}")
    for child in by_parent.get(agent.get("agent_id"), []):
        append_agent(lines, child, by_parent, depth + 1)


def one_line(value: str, limit: int = 220) -> str:
    text = " ".join((value or "").split())
    return text[:limit]


def readable_intent(agent) -> str:
    intent = agent.get("intent") or ""
    if intent and not is_boilerplate_intent(intent):
        return intent
    return infer_intent(agent.get("prompt") or "")


def block(value: str, width: int = 100) -> str:
    text = " ".join((value or "").split())
    return textwrap.shorten(text, width=width, placeholder=" ...")
