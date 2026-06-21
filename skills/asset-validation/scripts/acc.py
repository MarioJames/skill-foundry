import argparse
import json
import os
import shutil
import sys
from pathlib import Path

try:  # works when imported as a package (tests, `python3 -m scripts.acc`)
    from . import catalog, cleanup, db, observe, rounds
    _SKILL_DIR = Path(__file__).resolve().parent.parent
except ImportError:  # works when run directly: `python3 .../scripts/acc.py`
    _SKILL_DIR = Path(__file__).resolve().parent.parent
    sys.path.insert(0, str(_SKILL_DIR))
    from scripts import catalog, cleanup, db, observe, rounds


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

    rc = sub.add_parser("record")
    rc.add_argument("--round", required=True)
    rc.add_argument("--transcript-file")
    rc.add_argument("--report")

    fd = sub.add_parser("finding")
    fd.add_argument("--round", required=True)
    fd.add_argument("--severity", required=True)
    fd.add_argument("--status", required=True)
    fd.add_argument("--summary", required=True)

    fz = sub.add_parser("finalize")
    fz.add_argument("--round", required=True)
    fz.add_argument("--verdict", required=True,
                    choices=["PASS", "CONDITIONAL", "FAIL", "blocked"])
    fz.add_argument("--next-round-reco")
    fz.add_argument("--keep-sandbox", action="store_true",
                    help="finalize without automatic round cleanup for debugging")

    cl = sub.add_parser("cleanup")
    cl.add_argument("--sandbox")
    cl.add_argument("--round",
                    help="resolve sandbox_path from a round id")

    hi = sub.add_parser("history")
    hi.add_argument("--asset", required=True)
    return p


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    args = _build_parser().parse_args(argv)
    con = db.connect()
    try:
        if args.cmd == "asset" and args.sub == "add":
            _emit({"id": catalog.add_asset(con, args.name, args.type, args.source)})
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
            cid = catalog.new_acceptance(
                con, asset["id"], goal,
                strategy=strategy, fixture_path=args.fixture,
                task_prompts=_read_json(args.task_prompts_file),
            )
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
            updates = {
                "status": args.status, "strategy": strategy,
                "acceptance_prompt": _read(args.prompt_file),
                "acceptance_criteria": _read(args.criteria_file),
                "task_prompts": _read_json(args.task_prompts_file),
            }
            catalog.update_acceptance(
                con, acceptance_id, **{k: v for k, v in updates.items() if v is not None})
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
            arow = catalog.get_acceptance(con, args.acceptance)
            if not arow:
                _emit({"error": f"acceptance not found: {args.acceptance}"})
                return 2
            fixture_path = arow["fixture_path"]
            if fixture_path and not Path(fixture_path).exists():
                _emit({"error": f"fixture not found: {fixture_path}"})
                return 2
            # open the round first so we have a stable round_tag for the sandbox
            rid = rounds.start_round(con, args.acceptance, mode=args.mode, n=args.n)
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
            plugin_install = None
            cli_args = ["--add-dir", _source_add_dir(row["asset_source"])]
            if row["asset_type"] == "plugin":
                plugin_install = observe.install_plugin_source(
                    row["sandbox_path"], row["asset_source"], name=row["asset_name"],
                )
                if plugin_install:
                    cli_args = [*plugin_install.get("cli_args", []), *cli_args]
            launched = observe.launch_round(
                row["round_tag"], row["sandbox_path"], cli, cli_args=cli_args,
            )
            _emit({
                "round": args.round,
                "round_tag": row["round_tag"],
                "sandbox": row["sandbox_path"],
                "cli": cli,
                "plugin_install": plugin_install,
                **launched,
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
            transcript = observe.capture_pane(pane, start=args.start)
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
        elif args.cmd == "record":
            rounds.record(con, args.round,
                          transcript=_read(args.transcript_file), report_append=args.report)
            _emit({"round": args.round, "recorded": True})
        elif args.cmd == "finding":
            rounds.add_finding(con, args.round, severity=args.severity,
                               status=args.status, summary=args.summary)
            _emit({"round": args.round, "finding": True})
        elif args.cmd == "finalize":
            rounds.finalize(con, args.round, verdict=args.verdict,
                            next_round_reco=args.next_round_reco)
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
        elif args.cmd == "history":
            _emit(catalog.history(con, args.asset))
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
