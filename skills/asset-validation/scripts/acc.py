import argparse
import json
import os
import shutil
import sys
from pathlib import Path

try:  # works when imported as a package (tests, `python3 -m scripts.acc`)
    from . import catalog, cleanup, db, observe, profiles, redact, rounds
    _SKILL_DIR = Path(__file__).resolve().parent.parent
except ImportError:  # works when run directly: `python3 .../scripts/acc.py`
    _SKILL_DIR = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(_SKILL_DIR))
    from scripts import catalog, cleanup, db, observe, profiles, redact, rounds


def _emit(obj):
    print(json.dumps(obj, ensure_ascii=False))


def _read(path):
    if not path:
        return None
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _read_json(path):
    """Read a task-prompts file as a {task_key: body} dict."""
    if not path:
        return None
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _choose_inline_or_file(inline, file_path, label):
    if inline and file_path:
        raise ValueError(f"use only one of --{label} or --{label}-file")
    value = inline if inline is not None else _read(file_path)
    if value is None:
        raise ValueError(f"missing required --{label} or --{label}-file")
    return value


def _source_add_dir(source_path) -> str:
    src = Path(source_path)
    return str(src if src.is_dir() else src.parent)


def _preflight(cli: str = "claude") -> dict:
    """Resolve the selected asset-under-test CLI. Returns check result."""
    if os.environ.get("ACCEPTANCE_SKIP_PREFLIGHT"):
        return {"ok": True, "cli": cli, "resolved": cli, "skipped": True}
    found = shutil.which(cli)
    if not found:
        return {"ok": False, "reason": f"selected CLI {cli!r} not on PATH",
                "cli": cli}
    return {"ok": True, "cli": cli, "resolved": found}


def _build_parser():
    p = argparse.ArgumentParser(prog="acc")
    sub = p.add_subparsers(dest="cmd", required=True)

    bs = sub.add_parser("bootstrap")
    bs.add_argument("--name", required=True)
    bs.add_argument("--type", required=True,
                    choices=["skill", "plugin", "rule", "agent"])
    bs.add_argument("--source", required=True)
    bs.add_argument("--goal")
    bs.add_argument("--goal-file")
    bs.add_argument("--strategy")
    bs.add_argument("--strategy-file")
    bs.add_argument("--fixture")
    bs.add_argument("--task-prompts-file",
                    help="JSON file: {task_key: body} fed to the asset-under-test")

    asset = sub.add_parser("asset").add_subparsers(dest="sub", required=True)
    a = asset.add_parser("add")
    a.add_argument("--name", required=True)
    a.add_argument("--type", required=True, choices=["skill", "plugin", "rule", "agent"])
    a.add_argument("--source", required=True)
    alist = asset.add_parser("list")
    alist.add_argument("--type", choices=["skill", "plugin", "rule", "agent"])
    alist.add_argument("--name")

    accept = sub.add_parser("accept").add_subparsers(dest="sub", required=True)
    an = accept.add_parser("new")
    an.add_argument("--asset", required=True, help="asset name or id")
    an.add_argument("--goal")
    an.add_argument("--goal-file")
    an.add_argument("--strategy")
    an.add_argument("--strategy-file")
    an.add_argument("--fixture")
    an.add_argument("--task-prompts-file",
                    help="JSON file: {task_key: body} fed to the asset-under-test")
    au = accept.add_parser("update")
    au.add_argument("--id")
    au.add_argument("--acceptance",
                    help="compatibility alias for --id")
    au.add_argument("--status", choices=["draft", "active", "done"])
    au.add_argument("--strategy")
    au.add_argument("--strategy-file")
    au.add_argument("--prompt-file")
    au.add_argument("--criteria-file")
    au.add_argument("--task-prompts-file",
                    help="JSON file: {task_key: body} fed to the asset-under-test")
    au.add_argument("--ladder-file",
                    help="JSON file: {rung: [task_key, ...]}")
    au.add_argument("--budget-max-rounds", type=int,
                    help="max non-blocked rounds before budget-exhausted")
    al = accept.add_parser("list")
    al.add_argument("--asset", help="asset name or id")
    al.add_argument("--status")

    st = sub.add_parser("start")
    st.add_argument("--acceptance", required=True)
    st.add_argument("--mode", required=True,
                    choices=["stop-loss", "collect-first", "hybrid"])
    st.add_argument("--n", type=int, default=1)
    st.add_argument("--cli", choices=["claude", "codex"], default="claude",
                    help="asset-under-test CLI to preflight; default: claude")

    ln = sub.add_parser("launch")
    ln.add_argument("--round", required=True)
    ln.add_argument("--cli", choices=["claude", "codex"], default="claude",
                    help="asset-under-test CLI to launch; default: claude")

    rsub = sub.add_parser("round").add_subparsers(dest="sub", required=True)
    rl = rsub.add_parser("list")
    rl.add_argument("--acceptance")
    rl.add_argument("--verdict",
                    choices=["PASS", "CONDITIONAL", "FAIL", "blocked", "running"])

    sh = sub.add_parser("show")
    sh.add_argument("kind", choices=["prompt", "criteria"])
    sh.add_argument("--acceptance", required=True)

    ft = sub.add_parser("feed-task")
    ft.add_argument("--acceptance")
    ft.add_argument("--round")
    ft.add_argument("--task", required=True)
    ft.add_argument("--pane")

    cp = sub.add_parser("capture")
    cp.add_argument("--pane")
    cp.add_argument("--round")
    cp.add_argument("--out")
    cp.add_argument("--start", default="-2000")

    wt = sub.add_parser("wait")
    wt.add_argument("--round")
    wt.add_argument("--pane")
    wt.add_argument("--idle-seconds", type=float, required=True)
    wt.add_argument("--max-seconds", type=float, required=True)

    rc = sub.add_parser("record")
    rc.add_argument("--round", required=True)
    rc.add_argument("--transcript-file")
    rc.add_argument("--report")

    fd = sub.add_parser("finding")
    fd_sub = fd.add_subparsers(dest="finding_cmd")
    fd.add_argument("--round")
    fd.add_argument("--severity")
    fd.add_argument("--status")
    fd.add_argument("--summary")
    fd.add_argument("--key")
    fd_add = fd_sub.add_parser("add")
    fd_add.add_argument("--round", required=True)
    fd_add.add_argument("--severity", required=True)
    fd_add.add_argument("--status", required=True)
    fd_add.add_argument("--summary", required=True)
    fd_add.add_argument("--key", default=None)
    fd_list = fd_sub.add_parser("list")
    fd_list.add_argument("--round", required=True)

    fz = sub.add_parser("finalize")
    fz.add_argument("--round", required=True)
    fz.add_argument("--verdict", required=True,
                    choices=["PASS", "CONDITIONAL", "FAIL", "blocked"])
    fz.add_argument("--next-round-reco")
    fz.add_argument("--keep-sandbox", action="store_true",
                    help="finalize without automatic round cleanup for debugging")
    fz.add_argument("--allow-partial",
                    help="override ladder coverage gate with a reason")

    cl = sub.add_parser("cleanup")
    cl.add_argument("--sandbox")
    cl.add_argument("--round",
                    help="resolve sandbox_path from a round id")

    prof = sub.add_parser("profile").add_subparsers(dest="sub", required=True)
    prof.add_parser("list")
    pr = prof.add_parser("run-task")
    pr.add_argument("--acceptance", required=True)
    pr.add_argument("--task", required=True)
    pr.add_argument("--mode", required=True,
                    choices=["stop-loss", "collect-first", "hybrid"])
    pr.add_argument("--cli", choices=["claude", "codex"], default="claude")
    pr.add_argument("--wait-seconds", type=float, default=60)
    pr.add_argument("--capture-start", default="-2000")
    pr.add_argument("--finalize-verdict",
                    choices=["PASS", "CONDITIONAL", "FAIL", "blocked"])
    pr.add_argument("--next-round-reco")

    hi = sub.add_parser("history")
    hi.add_argument("--asset", required=True)
    return p


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    args = _build_parser().parse_args(argv)
    con = db.connect()
    try:
        if args.cmd == "bootstrap":
            try:
                reg = catalog.register_asset(con, args.name, args.type, args.source)
                goal = _choose_inline_or_file(args.goal, args.goal_file, "goal")
                strategy = args.strategy
                if args.strategy_file:
                    if strategy:
                        raise ValueError(
                            "use only one of --strategy or --strategy-file")
                    strategy = _read(args.strategy_file)
                cid = catalog.new_acceptance(
                    con, reg["id"], goal,
                    strategy=strategy, fixture_path=args.fixture,
                    task_prompts=_read_json(args.task_prompts_file),
                )
            except (ValueError, json.JSONDecodeError) as exc:
                _emit({"error": str(exc)})
                return 2
            _emit({
                "asset_id": reg["id"],
                "asset_created": reg["created"],
                "warning": reg["warning"],
                "acceptance_id": cid,
            })
        elif args.cmd == "asset" and args.sub == "add":
            try:
                _emit(catalog.register_asset(con, args.name, args.type, args.source))
            except ValueError as exc:
                _emit({"error": str(exc)})
                return 2
        elif args.cmd == "asset" and args.sub == "list":
            rows = catalog.list_assets(con, type=args.type, name=args.name)
            _emit({"assets": [dict(r) for r in rows]})
        elif args.cmd == "accept" and args.sub == "new":
            asset = catalog.get_asset(con, args.asset)
            if not asset:
                _emit({"error": f"asset not found: {args.asset}"})
                return 2
            try:
                goal = _choose_inline_or_file(args.goal, args.goal_file, "goal")
            except ValueError as exc:
                _emit({"error": str(exc)})
                return 2
            strategy = args.strategy
            if args.strategy_file:
                if strategy:
                    _emit({"error": "use only one of --strategy or --strategy-file"})
                    return 2
                strategy = _read(args.strategy_file)
            try:
                cid = catalog.new_acceptance(
                    con, asset["id"], goal,
                    strategy=strategy, fixture_path=args.fixture,
                    task_prompts=_read_json(args.task_prompts_file),
                )
            except (ValueError, json.JSONDecodeError) as exc:
                _emit({"error": str(exc)})
                return 2
            _emit({"id": cid})
        elif args.cmd == "accept" and args.sub == "update":
            acceptance_id = args.id or args.acceptance
            if not acceptance_id:
                _emit({"error": "accept update requires --id or --acceptance"})
                return 2
            strategy = args.strategy
            if args.strategy_file:
                if strategy:
                    _emit({"error": "use only one of --strategy or --strategy-file"})
                    return 2
                strategy = _read(args.strategy_file)
            try:
                updates = {
                    "status": args.status, "strategy": strategy,
                    "acceptance_prompt": _read(args.prompt_file),
                    "acceptance_criteria": _read(args.criteria_file),
                    "task_prompts": _read_json(args.task_prompts_file),
                    "ladder": _read_json(args.ladder_file),
                    "budget_max_rounds": args.budget_max_rounds,
                }
                catalog.update_acceptance(
                    con, acceptance_id,
                    **{k: v for k, v in updates.items() if v is not None})
            except (ValueError, json.JSONDecodeError) as exc:
                _emit({"error": str(exc)})
                return 2
            _emit({"id": acceptance_id, "updated": True})
        elif args.cmd == "accept" and args.sub == "list":
            asset_id = None
            if args.asset:
                asset = catalog.get_asset(con, args.asset)
                asset_id = asset["id"] if asset else "__none__"
            rows = catalog.list_acceptances(con, asset_id=asset_id, status=args.status)
            _emit({"acceptances": [dict(r) for r in rows]})
        elif args.cmd == "start":
            pre = _preflight(args.cli)
            if not pre["ok"]:
                _emit({"preflight": "fail", **pre})
                return 2
            try:
                depth = int(os.environ.get("ACCEPTANCE_DEPTH", "0"))
            except ValueError:
                depth = 0
            if depth >= 2:
                _emit({"error": f"acceptance recursion depth exceeded: {depth + 1}",
                       "blocked": "depth-exceeded"})
                return 2
            arow = catalog.get_acceptance(con, args.acceptance)
            if not arow:
                _emit({"error": f"acceptance not found: {args.acceptance}"})
                return 2
            fixture_path = arow["fixture_path"]
            if fixture_path and not Path(fixture_path).exists():
                _emit({"error": f"fixture not found: {fixture_path}"})
                return 2
            # open the round first so we have a stable round_tag for the sandbox
            try:
                rid = rounds.start_round(con, args.acceptance, mode=args.mode, n=args.n)
            except rounds.BudgetExceeded as exc:
                _emit({"error": str(exc), "blocked": "budget-exhausted"})
                return 2
            rrow = rounds.get_round_target(con, rid)
            sandbox = observe.make_sandbox(rrow["round_tag"])
            fixture_copy = observe.rsync_fixture(fixture_path, sandbox)
            rounds.set_sandbox_path(con, rid, sandbox)
            _emit({
                "id": rid, "round_tag": rrow["round_tag"],
                "preflight": "ok", "cli": pre["cli"], "resolved": pre["resolved"],
                "sandbox": str(sandbox),
                "fixture": str(fixture_copy) if fixture_copy else None,
                "isolation_env": observe.isolation_env(sandbox),
            })
        elif args.cmd == "launch":
            pre = _preflight(args.cli)
            if not pre["ok"]:
                _emit({"preflight": "fail", **pre})
                return 2
            row = rounds.get_launch_target(con, args.round)
            if not row:
                _emit({"error": f"round not found: {args.round}"})
                return 2
            if not row["sandbox_path"]:
                _emit({"error": f"round has no sandbox_path: {args.round}"})
                return 2
            if not Path(row["sandbox_path"]).exists():
                _emit({"error": f"round sandbox not found: {row['sandbox_path']}"})
                return 2
            cli = pre["resolved"] or pre["cli"]
            launch = profiles.launch_round_for_target(row, cli)
            _emit({
                "round": args.round,
                "round_tag": row["round_tag"],
                "sandbox": row["sandbox_path"],
                "cli": cli,
                "plugin_install": launch.get("plugin_install"),
                "session": launch["session"],
                "pane": launch["pane"],
                "existing": launch["existing"],
            })
        elif args.cmd == "round" and args.sub == "list":
            rows = rounds.list_rounds(
                con, acceptance_id=args.acceptance, verdict=args.verdict,
            )
            _emit({"rounds": [dict(r) for r in rows]})
        elif args.cmd == "show":
            body = catalog.get_acceptance_body(con, args.acceptance, args.kind)
            _emit({"kind": args.kind, "body": body})
        elif args.cmd == "feed-task":
            acceptance_id = args.acceptance
            pane = args.pane
            if args.round:
                row = rounds.get_round_target(con, args.round)
                if not row:
                    _emit({"error": f"round not found: {args.round}"})
                    return 2
                acceptance_id = acceptance_id or row["acceptance_id"]
                pane = pane or f"{observe.session_name(row['round_tag'])}:0.0"
            if not acceptance_id or not pane:
                _emit({"error": "feed-task requires --acceptance/--pane or --round"})
                return 2
            try:
                body = observe.feed_task(con, acceptance_id, args.task, pane)
            except KeyError:
                _emit({"error": f"task {args.task!r} not found for acceptance "
                                 f"{acceptance_id} (set via --task-prompts-file)"})
                return 2
            except RuntimeError as exc:
                _emit({"error": str(exc)})
                return 2
            if args.round:
                rounds.add_task_key(con, args.round, args.task)
            _emit({"fed": True, "task": args.task, "chars": len(body), "pane": pane})
        elif args.cmd == "capture":
            pane = args.pane
            if args.round:
                row = rounds.get_round_target(con, args.round)
                if not row:
                    _emit({"error": f"round not found: {args.round}"})
                    return 2
                pane = pane or f"{observe.session_name(row['round_tag'])}:0.0"
            if not pane:
                _emit({"error": "capture requires --pane or --round"})
                return 2
            transcript = redact.redact_secrets(
                observe.capture_pane(pane, start=args.start)
            )
            out_path = None
            if args.out:
                out_path = Path(args.out)
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(transcript, encoding="utf-8")
            _emit({
                "pane": pane,
                "chars": len(transcript),
                "out": str(out_path) if out_path else None,
            })
        elif args.cmd == "wait":
            pane = args.pane
            if args.round:
                row = rounds.get_round_target(con, args.round)
                if not row:
                    _emit({"error": f"round not found: {args.round}"})
                    return 2
                pane = pane or f"{observe.session_name(row['round_tag'])}:0.0"
            if not pane:
                _emit({"error": "wait requires --pane or --round"})
                return 2
            idle = observe.wait_for_idle(
                pane, idle_seconds=args.idle_seconds,
                max_seconds=args.max_seconds,
            )
            _emit({"pane": pane, "idle": idle})
        elif args.cmd == "record":
            transcript = _read(args.transcript_file)
            if transcript is not None:
                transcript = redact.redact_secrets(transcript)
            rounds.record(con, args.round,
                          transcript=transcript, report_append=args.report)
            _emit({"round": args.round, "recorded": True})
        elif args.cmd == "finding":
            if args.finding_cmd == "list":
                _emit({"findings": rounds.list_findings(con, args.round)})
            else:
                missing = [
                    name for name in ("round", "severity", "status", "summary")
                    if not getattr(args, name)
                ]
                if missing:
                    _emit({"error": "finding add missing: " + ", ".join(missing)})
                    return 2
                fid = rounds.add_finding(
                    con, args.round, severity=args.severity,
                    status=args.status, summary=args.summary, key=args.key,
                )
                _emit({"round": args.round, "finding": True, "id": fid})
        elif args.cmd == "finalize":
            if args.verdict == "PASS" and not args.allow_partial:
                ok, reason = catalog.can_finalize_pass(con, args.round)
                if not ok:
                    _emit({"error": reason})
                    return 2
            rounds.finalize(con, args.round, verdict=args.verdict,
                            next_round_reco=args.next_round_reco)
            if args.allow_partial and args.verdict == "PASS":
                rounds.add_finding(
                    con, args.round, severity="P2", status="waived",
                    summary=f"ladder coverage overridden: {args.allow_partial}",
                    key="allow-partial",
                )
            cleanup_result = None
            cleanup_skipped = None
            if args.keep_sandbox:
                cleanup_skipped = "keep-sandbox"
            else:
                try:
                    cleanup_result = cleanup.cleanup_round(con, args.round)
                except (LookupError, ValueError) as exc:
                    _emit({"error": str(exc)})
                    return 2
            _emit({
                "round": args.round,
                "verdict": args.verdict,
                "cleanup": cleanup_result,
                "cleanup_skipped": cleanup_skipped,
            })
        elif args.cmd == "cleanup":
            sandbox = args.sandbox
            if args.round:
                try:
                    _emit(cleanup.cleanup_round(con, args.round, sandbox=sandbox))
                except (LookupError, ValueError) as exc:
                    _emit({"error": str(exc)})
                    return 2
            else:
                if not sandbox:
                    _emit({"error": "cleanup requires --sandbox or --round"})
                    return 2
                _emit(observe.cleanup(sandbox))
        elif args.cmd == "profile" and args.sub == "list":
            _emit({"profiles": profiles.list_profiles()})
        elif args.cmd == "profile" and args.sub == "run-task":
            pre = _preflight(args.cli)
            if not pre["ok"]:
                _emit({"preflight": "fail", **pre})
                return 2
            try:
                out = profiles.run_task(
                    con, args.acceptance, args.task,
                    mode=args.mode,
                    cli=pre["resolved"] or pre["cli"],
                    wait_seconds=args.wait_seconds,
                    capture_start=args.capture_start,
                    finalize_verdict=args.finalize_verdict,
                    next_round_reco=args.next_round_reco,
                )
            except (KeyError, ValueError, NotImplementedError, RuntimeError) as exc:
                payload = {"error": str(exc)}
                if isinstance(exc, rounds.BudgetExceeded):
                    payload["blocked"] = "budget-exhausted"
                _emit(payload)
                return 2
            _emit({"preflight": "ok", "cli": pre["cli"], **out})
        elif args.cmd == "history":
            _emit(catalog.history(con, args.asset))
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
