import pathlib


def prompt_prefix_for_kind(kind: str) -> str:
    if kind == "implement":
        return (
            "You are a recursive implementation node: if the task is small enough, do it yourself and "
            "finish; if it is large enough or can be split into non-overlapping subtasks, you may keep "
            "calling dispatch to spawn the next layer of implement children, and you MUST then await-round "
            "to converge. When splitting, maximize the number of children — prefer many focused agents "
            "(each handling one file or one component) over fewer broad agents, so each child finishes "
            "fast and reduces round wait time. Only merge tasks when they share files or have tight "
            "ordering dependencies. Do NOT use git worktree for isolation; instead control each child's "
            "scope so files don't overlap — worktrees are a last resort only when parallel agents truly "
            "cannot avoid the same file. Shared files, scaffold, route wiring, and global config MUST be "
            "serialized or left to the parent for integration; parallel subtasks may only write "
            "non-overlapping files. "
            "await-round returning listen_window_expired:true/still_waiting:true only means this listen "
            "window ended, NOT a failure; you MUST continue await-round or read the same background await "
            "output, and MUST NOT dispatch review/fix. After the await-round summary shows a failed child, "
            "first dispatch a review leaf to judge whether it is a real failure, completed but failed to "
            "report, or needs retry/fix; then re-dispatch implement or dispatch a fix leaf per the review "
            "verdict and review again. If build/lint/test/browser verification exposes cross-module or bulk "
            "problems, prefer dispatching a review leaf to attribute them, then retry per fix_scopes or "
            "dispatch a fix leaf and review again; the parent's last direct child before finish MUST be a "
            "done review. Do NOT use Claude Code's built-in Agent/Task/Workflow or other background/sub-task "
            "capability to bypass this protocol; every parallelizable delegation MUST go through this "
            "skill's dispatch to create a trackable child. A normal text summary does NOT finish this "
            "node; before ending your final response, your final tool call MUST be the "
            "agent_orchestrator.py finish command for your injected agent_id/root_id."
        )
    if kind in {"review", "fix"}:
        return (
            "You are a leaf node: do NOT call dispatch, claude --bg, claude agents, Agent/Task/Workflow, or "
            "any other background/sub-task capability; after finishing the review or fix, call finish directly."
        )
    raise ValueError(f"unsupported child kind: {kind}")


def build_child_prompt(agent_id, parent_id, root_id, round_, kind, task, skill_dir_path) -> str:
    protocol_path = pathlib.Path(skill_dir_path) / "references" / "recursion-protocol.md"
    dispatch_policy = prompt_prefix_for_kind(kind)
    identity = (
        f"[ORCHESTRATION IDENTITY] You are a task-tree worker: agent_id={agent_id} parent={parent_id} "
        f"root={root_id} round={round_} kind={kind}\n"
        f"[DISPATCH DISCIPLINE] {dispatch_policy}\n"
    )
    if kind == "implement":
        return (
            "ultra team\n\n"
            f"{identity}"
            "You MUST load the ultra-team skill first; do NOT read the protocol directly in place "
            f"of loading the skill. After loading the skill, read and strictly follow {protocol_path}. "
            "You are NOT a new root; do NOT call init. "
            "If the current task is small enough, finish it directly as a leaf; if it genuinely needs "
            "further splitting, you decide dispatch/await-round/review/fix yourself. Normal prose like "
            "'I am done' or 'will report via finish' is NOT completion. When your implementation node is "
            "ready to close, your final action MUST be this exact command shape: "
            f"python3 {pathlib.Path(skill_dir_path) / 'scripts' / 'agent_orchestrator.py'} "
            f"finish --agent-id {agent_id} --root-id {root_id} --result \"<your result>\" "
            "--caveats \"<unresolved items, optional>\".\n\n"
            f"[TASK] {task}"
        )
    return (
        f"{identity}"
        f"Do NOT trigger or load the orchestration skill; you are a leaf node, just complete this task and report. "
        f"When done, call: python3 {pathlib.Path(skill_dir_path) / 'scripts' / 'agent_orchestrator.py'} "
        f"finish --agent-id {agent_id} --root-id {root_id} --result \"<your result>\" "
        "--caveats \"<unresolved items, optional>\".\n\n"
        f"[TASK] {task}"
    )
