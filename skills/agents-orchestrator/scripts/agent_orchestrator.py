#!/usr/bin/env python3
"""Thin command-line surface for the canonical Agents Orchestrator Runtime."""

import argparse
import json
import os
import secrets
import sys
import uuid

import action_processor
import compat_env
import execution_config
import execution_secrets
import hook_manager
import mode_models
import outbox
import recovery
import session_history
import state_store


DEFAULT_MODEL_TIERS = {"strong": "opus", "balanced": "sonnet", "fast": "haiku"}
OWNER_LEASE_SECONDS = 15 * 60
ENTRY_MODE_ALIASES = {
    "swarm": "swarm",
    "loop": "develop_review_improve",
    "develop-review-improve": "develop_review_improve",
    "develop_review_improve": "develop_review_improve",
    "review": "multi_session_review",
    "multi-session-review": "multi_session_review",
    "multi_session_review": "multi_session_review",
}


ACTION_SCHEMAS = {
    "submit_estimate": {
        "title": "submit_estimate",
        "type": "object",
        "required": ["revision", "strategy", "resolved_intent", "complexity", "concerns", "unknowns", "estimated_files", "reason"],
        "properties": {
            "revision": {"type": "boolean"},
            "strategy": {"enum": ["direct", "split"]},
            "resolved_intent": {"enum": ["implement", "review", "fix", "research", "design", "integrate"]},
            "complexity": {"enum": ["low", "medium", "high"]},
            "concerns": {"type": "array"},
            "unknowns": {"type": "array"},
            "estimated_files": {"type": "array", "items": {"type": "string"}},
            "reason": {"type": "string"},
        },
    },
    "create_tasks": {
        "title": "create_tasks",
        "type": "object",
        "required": ["tasks"],
        "properties": {
            "tasks": {
                "type": "array",
                "minItems": 1,
                "maxItems": 12,
                "items": {
                    "type": "object",
                    "required": ["key", "goal", "intent_hint", "output_contract"],
                    "properties": {
                        "key": {"type": "string"},
                        "goal": {"type": "string"},
                        "intent_hint": {
                            "enum": ["implement", "review", "fix", "research", "design", "integrate"]
                        },
                        "complexity_hint": {"enum": ["low", "medium", "high"]},
                        "model_tier_hint": {"enum": ["strong", "balanced", "fast", None]},
                        "priority": {"type": "integer", "minimum": 0, "maximum": 100},
                        "output_contract": {"type": "string"},
                        "constraints": {
                            "type": "object",
                            "properties": {
                                "write_scope": {"type": "array", "items": {"type": "string"}},
                                "read_only": {"type": "boolean"},
                                "notes": {"type": "array"},
                                "profile_hint": {"type": "string", "minLength": 1},
                            },
                        },
                        "depends_on": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "task_key": {"type": "string"},
                                    "task_id": {"type": "integer"},
                                    "condition": {"enum": ["success", "terminal"]},
                                },
                            },
                        },
                    },
                },
            }
        },
    },
    "write_note": {
        "title": "write_note",
        "type": "object",
        "required": ["category", "content", "scope"],
        "properties": {
            "category": {"enum": ["decision", "pitfall", "note"]},
            "content": {"type": "string", "maxLength": 500},
            "scope": {"enum": ["global", "subtree", "task"]},
            "pinned": {"type": "boolean"},
            "supersedes_id": {"type": ["integer", "null"]},
        },
    },
    "wait": {
        "title": "wait",
        "type": "object",
        "required": ["task_ids", "condition", "listen_seconds"],
        "properties": {
            "task_ids": {"type": "array", "minItems": 1, "items": {"type": "integer"}},
            "condition": {"enum": ["all_done", "all_terminal", "any_failed"]},
            "listen_seconds": {"type": "number", "minimum": 0, "maximum": 300},
        },
    },
    "start_mode": mode_models.START_MODE_SCHEMA,
    "advance_mode": mode_models.ADVANCE_MODE_SCHEMA,
    "finish": {
        "title": "finish",
        "type": "object",
        "required": ["status", "summary", "caveats"],
        "properties": {
            "status": {"enum": ["done", "failed"]},
            "retryable": {"type": "boolean"},
            "summary": {"type": "string"},
            "changed_files": {"type": "array", "items": {"type": "string"}},
            "artifacts": {"type": "array"},
            "validation": {"type": ["object", "null"]},
            "review": {"type": ["object", "null"]},
            "integration_check": {"type": ["object", "null"]},
            "mode_result": {"type": ["object", "null"]},
            "caveats": {"type": "array"},
        },
    },
}


def _id(prefix):
    return "%s_%s" % (prefix, uuid.uuid4().hex[:12])


def _positive(name, value, minimum, maximum):
    if not minimum <= value <= maximum:
        raise ValueError("%s must be in %d..%d" % (name, minimum, maximum))
    return value


def _entry_mode(explicit=None, environment=None):
    environment = os.environ if environment is None else environment
    inherited = compat_env.value("MODE", environment)

    def normalize(raw):
        if raw is None or (isinstance(raw, str) and not raw.strip()):
            return None
        if not isinstance(raw, str):
            raise ValueError("entry_mode must be a string")
        normalized = ENTRY_MODE_ALIASES.get(raw.strip())
        if normalized is None:
            raise ValueError("entry_mode must be swarm, loop, or review")
        return normalized

    selected = normalize(explicit)
    inherited = normalize(inherited)
    if selected is not None and inherited is not None and selected != inherited:
        raise ValueError("explicit entry_mode conflicts with orchestration MODE")
    return selected if selected is not None else inherited


def initialize_run(
    task,
    cwd,
    max_concurrent_agents=8,
    max_total_tasks=100,
    max_attempts_per_task=2,
    max_delegation_depth=5,
    max_replans_per_task=2,
    max_children_per_action=12,
    require_final_review=True,
    model_tiers=None,
    backend=None,
    acp_agent=None,
    acp_command=None,
    acp_args=None,
    acp_permission_policy=None,
    profile_allowlist=None,
    default_profile=None,
    entry_mode=None,
):
    if not isinstance(task, str) or not task.strip():
        raise ValueError("task is required")
    cwd = os.path.realpath(cwd)
    if not os.path.isdir(cwd):
        raise ValueError("cwd does not exist: %s" % cwd)
    _positive("max_concurrent_agents", max_concurrent_agents, 1, 256)
    _positive("max_total_tasks", max_total_tasks, 1, 10000)
    _positive("max_attempts_per_task", max_attempts_per_task, 1, 20)
    _positive("max_delegation_depth", max_delegation_depth, 0, 20)
    _positive("max_replans_per_task", max_replans_per_task, 0, 20)
    _positive("max_children_per_action", max_children_per_action, 1, 12)
    selected_entry_mode = _entry_mode(entry_mode)
    execution = execution_config.resolve_run_execution(
        backend=backend,
        acp_agent=acp_agent,
        acp_command=acp_command,
        acp_args=acp_args,
        acp_permission_policy=acp_permission_policy,
        profile_allowlist=profile_allowlist,
        default_profile=default_profile,
        install_dependencies=True,
    )
    execution["entry_mode"] = selected_entry_mode
    tiers = dict(DEFAULT_MODEL_TIERS)
    if execution["backend"] == "acp":
        tiers = dict(execution.get("acp", {}).get("model_tiers") or tiers)
    if model_tiers:
        tiers.update(model_tiers)
    if set(tiers) != {"strong", "balanced", "fast"} or not all(
        isinstance(value, str) and value for value in tiers.values()
    ):
        raise ValueError("model_tiers must map strong, balanced, and fast")

    root_id = _id("root")
    actor_token = "as_" + secrets.token_urlsafe(32)
    created = state_store.now()
    seed_reference = None
    try:
        seed_reference, seed_hash = execution_secrets.create_run_seed(root_id)
        with state_store.transaction() as con:
            conflict = con.execute(
                """SELECT root_id, status FROM runs
                   WHERE cwd=? AND status IN ('running','stopping','failed')
                   ORDER BY created_at DESC LIMIT 1""",
                (cwd,),
            ).fetchone()
            if conflict:
                raise ValueError(
                    "cwd already has recoverable run %s (%s); use recover instead of init"
                    % (conflict["root_id"], conflict["status"])
                )
            con.execute(
                """INSERT INTO runs(
                     root_id, goal, cwd, status, root_task_id,
                     max_concurrent_agents, max_total_tasks, max_attempts_per_task,
                     max_delegation_depth, max_replans_per_task, max_children_per_action,
                     require_final_review, model_tiers_json, execution_config_json,
                     token_seed_ref, token_seed_hash, owner_token_hash,
                     lease_epoch, lease_expires_at, created_at, updated_at
                   ) VALUES (?, ?, ?, 'running', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)""",
                (
                    root_id,
                    task.strip(),
                    cwd,
                    max_concurrent_agents,
                    max_total_tasks,
                    max_attempts_per_task,
                    max_delegation_depth,
                    max_replans_per_task,
                    max_children_per_action,
                    1 if require_final_review else 0,
                    json.dumps(tiers, sort_keys=True),
                    json.dumps(execution, sort_keys=True),
                    seed_reference,
                    seed_hash,
                    state_store.hash_token(actor_token),
                    created + OWNER_LEASE_SECONDS,
                    created,
                    created,
                ),
            )
            cursor = con.execute(
                """INSERT INTO tasks(
                     root_id, goal, intent_hint, status, priority, complexity_hint,
                     output_contract, constraints_json, delegation_depth,
                     replan_count, created_at
                   ) VALUES (?, ?, 'implement', 'active', 100, 'high', ?, ?, 0, 0, ?)""",
                (root_id, task.strip(), task.strip(), json.dumps({}), created),
            )
            task_id = cursor.lastrowid
            root_run = state_store.get_run(root_id, con)
            root_config = execution_config.snapshot_attempt(root_run, model=tiers["strong"])
            cursor = con.execute(
                """INSERT INTO attempts(
                     task_id, attempt_no, state, actor_token_hash, backend_id, agent_type,
                     model_tier, model_name, config_json, heartbeat_at,
                     created_at, started_at
                   ) VALUES (?, 1, 'evaluating', ?, ?, ?, 'strong', ?, ?, ?, ?, ?)""",
                (
                    task_id,
                    state_store.hash_token(actor_token),
                    execution["backend"],
                    execution.get("acp", {}).get("agent")
                    if execution["backend"] == "acp"
                    else "claude",
                    tiers["strong"],
                    json.dumps(root_config, sort_keys=True),
                    created,
                    created,
                    created,
                ),
            )
            attempt_id = cursor.lastrowid
            con.execute(
                "UPDATE runs SET root_task_id=? WHERE root_id=?",
                (task_id, root_id),
            )
            state_store.append_event(
                con, root_id, "RunInitialized", {"task": task.strip()}, task_id=task_id,
                attempt_id=attempt_id,
            )
    except Exception:
        if seed_reference:
            execution_secrets.remove_run_seed(
                {"token_seed_ref": seed_reference}
            )
        raise
    if execution_config.supports_hooks(execution):
        try:
            hook_manager.ensure_project_hooks(cwd, root_id=root_id)
        except Exception:
            with state_store.transaction() as con:
                con.execute("DELETE FROM runs WHERE root_id=?", (root_id,))
            execution_secrets.remove_run_seed(
                {"token_seed_ref": seed_reference}
            )
            raise
    return {
        "root_id": root_id,
        "task_id": task_id,
        "attempt_id": attempt_id,
        "actor_token": actor_token,
        "lease_epoch": 0,
        "lease_expires_at": created + OWNER_LEASE_SECONDS,
        "entry_mode": selected_entry_mode,
    }


def _resolve(explicit, env_name, label, required=True):
    suffix = (
        env_name[len(compat_env.LEGACY_PREFIX) :]
        if env_name.startswith(compat_env.LEGACY_PREFIX)
        else env_name
    )
    environment = compat_env.value(suffix)
    if explicit and environment and explicit != environment:
        raise ValueError(
            "explicit %s does not match orchestration %s" % (label, suffix)
        )
    value = explicit or environment
    if required and not value:
        raise ValueError(
            "%s is required (argument or %s/%s)"
            % (
                label,
                compat_env.canonical_name(suffix),
                compat_env.legacy_name(suffix),
            )
        )
    return value


def _resolve_int(explicit, env_name, label):
    value = _resolve(explicit, env_name, label)
    try:
        value = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("%s must be an integer" % label) from exc
    if value <= 0:
        raise ValueError("%s must be a positive integer" % label)
    return value


def _refresh_run_hooks(root_id, cwd=None):
    run = state_store.get_run(root_id)
    if run is not None and execution_config.supports_hooks(execution_config.load_run_execution(run)):
        hook_manager.ensure_project_hooks(cwd or run["cwd"], root_id=root_id)


def _print(data):
    print(json.dumps(data, ensure_ascii=False, sort_keys=True))


def _action_command(args):
    root_id = _resolve(args.root_id, "AGENT_SWARM_ROOT_ID", "root_id")
    task_id = _resolve_int(args.task_id, "AGENT_SWARM_TASK_ID", "task_id")
    attempt_id = _resolve_int(args.attempt_id, "AGENT_SWARM_ATTEMPT_ID", "attempt_id")
    token = _resolve(args.actor_token, "AGENT_SWARM_ACTOR_TOKEN", "actor_token")
    _refresh_run_hooks(root_id, cwd=os.getcwd())
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError) as exc:
        raise ValueError("action --stdin requires one JSON object: %s" % exc)
    envelope = {
        "schema_version": 1,
        "action_id": args.action_id or _id("action"),
        "root_id": root_id,
        "task_id": task_id,
        "attempt_id": attempt_id,
        "actor_token": token,
        "type": args.type,
        "payload": payload,
    }
    response = action_processor.process_action(envelope)
    side_effects = outbox.drain(root_id)
    response = dict(response)
    response["side_effects"] = side_effects
    execution_secrets.cleanup_run_seed_if_safe(root_id)
    _print(response)


def _authorize_read(root_id, actor_token):
    state_store.initialize_schema()
    run = state_store.get_run(root_id)
    if run is None:
        raise ValueError("run not found")
    valid = any(
        state_store.token_matches(actor_token, attempt["actor_token_hash"])
        for attempt in state_store.list_attempts(root_id)
    )
    if not valid:
        raise ValueError("invalid actor token")
    return run


def _inspect_command(args):
    state_store.initialize_schema()
    root_id = None
    if args.run:
        root_id = args.run
    elif args.notes:
        root_id = args.notes
    elif args.events:
        root_id = args.events
    elif args.children:
        task = state_store.get_task(args.children)
        if task is None:
            raise ValueError("task not found")
        root_id = task["root_id"]
    elif args.mode is not None:
        mode = state_store.get_mode(args.mode)
        if mode is None:
            raise ValueError("mode not found")
        root_id = mode["root_id"]
    else:
        root_id = _resolve(args.root_id, "AGENT_SWARM_ROOT_ID", "root_id")
    token = _resolve(args.actor_token, "AGENT_SWARM_ACTOR_TOKEN", "actor_token")
    run = _authorize_read(root_id, token)
    if args.notes:
        data = {"root_id": root_id, "notes": state_store.list_notes(root_id)}
    elif args.events:
        data = {"root_id": root_id, "events": state_store.list_events(root_id, args.limit)}
    elif args.children:
        data = {
            "task_id": args.children,
            "children": state_store.fetchall(
                "SELECT * FROM tasks WHERE parent_task_id=? ORDER BY created_at", (args.children,)
            ),
        }
    elif args.mode is not None:
        data = {
            "root_id": root_id,
            "modes": state_store.inspect_modes(root_id, mode_id=args.mode),
        }
    elif args.current:
        task_id = _resolve_int(args.task_id, "AGENT_SWARM_TASK_ID", "task_id")
        task = state_store.get_task(task_id)
        if task is None or task["root_id"] != root_id:
            raise ValueError("current task does not belong to the authorized run")
        attempt = state_store.get_current_attempt(task_id)
        if (
            attempt is None
            or attempt["root_id"] != root_id
            or attempt["task_id"] != task_id
        ):
            raise ValueError("current attempt binding is invalid")
        launch = state_store.get_current_launch(attempt["attempt_id"])
        session = state_store.get_session_for_launch(launch["launch_id"]) if launch else None
        data = {
            "run": run,
            "task": task,
            "attempt": attempt,
            "launch": launch,
            "session": session,
        }
    else:
        data = {
            "run": run,
            "tasks": state_store.list_tasks(root_id),
            "attempts": state_store.list_attempts(root_id),
            "launches": state_store.list_launches(root_id),
            "sessions": state_store.list_sessions(root_id),
            "effects": state_store.list_effects(root_id),
            "modes": state_store.inspect_modes(root_id),
        }
    _print(data)


def _identity_values(args):
    return {
        "root_id": _resolve(args.root_id, "AGENT_SWARM_ROOT_ID", "root_id"),
        "task_id": _resolve_int(args.task_id, "AGENT_SWARM_TASK_ID", "task_id"),
        "attempt_id": _resolve_int(args.attempt_id, "AGENT_SWARM_ATTEMPT_ID", "attempt_id"),
        "actor_token": _resolve(args.actor_token, "AGENT_SWARM_ACTOR_TOKEN", "actor_token"),
    }


def _bootstrap_cwd_command(args):
    """Authenticate the child and perform Backend-specific cwd bootstrap."""
    values = _identity_values(args)
    heartbeat = recovery.heartbeat(**values)
    if not heartbeat.get("accepted"):
        raise RuntimeError("bootstrap-cwd requires a current, running Attempt")
    run = state_store.get_run(values["root_id"])
    settings_path = None
    hooks_enabled = bool(
        run and execution_config.supports_hooks(execution_config.load_run_execution(run))
    )
    if hooks_enabled:
        settings_path = hook_manager.ensure_project_hooks(os.getcwd(), root_id=values["root_id"])
    _print(
        {
            "initialized": True,
            "hooks_enabled": hooks_enabled,
            "settings_path": settings_path,
            "heartbeat": heartbeat,
        }
    )


def _discover_root(cwd):
    state_store.initialize_schema()
    rows = state_store.fetchall(
        """SELECT * FROM runs WHERE cwd=? AND status IN ('running','failed','stopping')
           ORDER BY created_at DESC""",
        (os.path.realpath(cwd),),
    )
    if len(rows) != 1:
        raise ValueError("recover requires exactly one recoverable run in cwd or --root-id")
    return rows[0]["root_id"]


def build_parser():
    parser = argparse.ArgumentParser(
        prog="agent_orchestrator.py", description="Agents Orchestrator Runtime"
    )
    commands = parser.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="initialize a foreground root run")
    init.add_argument("--task", required=True)
    init.add_argument("--cwd", required=True)
    init.add_argument("--max-concurrent-agents", type=int, default=8)
    init.add_argument("--max-total-tasks", type=int, default=100)
    init.add_argument("--max-attempts-per-task", type=int, default=2)
    init.add_argument("--max-delegation-depth", type=int, default=5)
    init.add_argument("--max-replans-per-task", type=int, default=2)
    init.add_argument("--max-children-per-action", type=int, default=12)
    init.add_argument("--no-final-review", action="store_true")
    init.add_argument("--model-tiers-json")
    init.add_argument("--backend", choices=["claude_cli", "acp"])
    init.add_argument("--acp-agent")
    init.add_argument("--acp-command")
    init.add_argument("--acp-args-json")
    init.add_argument("--profile-allowlist-json")
    init.add_argument("--default-profile")
    init.add_argument("--entry-mode")
    init.add_argument(
        "--acp-permission-policy",
        choices=["allow_in_workspace", "allow_all", "deny_all", "prompt"],
    )

    action = commands.add_parser("action", help="submit one structured runtime action")
    action.add_argument("--type", required=True, choices=sorted(ACTION_SCHEMAS))
    action.add_argument("--stdin", action="store_true", required=True)
    action.add_argument("--action-id")
    for name in ("root-id", "task-id", "attempt-id", "actor-token"):
        action.add_argument("--" + name)

    schema = commands.add_parser("action-schema", help="print an action JSON schema")
    schema.add_argument("action", nargs="?", choices=sorted(ACTION_SCHEMAS))

    inspect = commands.add_parser("inspect", help="read current runtime facts")
    group = inspect.add_mutually_exclusive_group()
    group.add_argument("--run")
    group.add_argument("--current", action="store_true")
    group.add_argument("--children", type=int)
    group.add_argument("--notes")
    group.add_argument("--events")
    group.add_argument("--mode", type=int)
    inspect.add_argument("--limit", type=int, default=50)
    inspect.add_argument("--root-id")
    inspect.add_argument("--task-id")
    inspect.add_argument("--actor-token")

    recover = commands.add_parser("recover", help="recover an existing run; never initializes a new run")
    recover.add_argument("--root-id")
    recover.add_argument("--cwd", default=os.getcwd())
    recover.add_argument("--force-takeover", action="store_true")

    reap = commands.add_parser(
        "reap", help="reclaim dead child attempts without replacing the foreground root"
    )
    reap.add_argument("--root-id")
    reap.add_argument("--actor-token")
    reap.add_argument("--kill-attempt", action="append", type=int, default=[])

    stop = commands.add_parser("stop", help="stop a run and its live sessions")
    stop.add_argument("--root-id")
    stop.add_argument("--actor-token")

    heartbeat = commands.add_parser("heartbeat", help="refresh the current agent heartbeat")
    for name in ("root-id", "task-id", "attempt-id", "actor-token"):
        heartbeat.add_argument("--" + name)

    worktree_init = commands.add_parser(
        "worktree-init", help="authenticate and install local hooks in the current worktree"
    )
    for name in ("root-id", "task-id", "attempt-id", "actor-token"):
        worktree_init.add_argument("--" + name)

    bootstrap_cwd = commands.add_parser(
        "bootstrap-cwd", help="authenticate and bootstrap the current Backend working directory"
    )
    for name in ("root-id", "task-id", "attempt-id", "actor-token"):
        bootstrap_cwd.add_argument("--" + name)

    doctor = commands.add_parser("doctor", help="diagnose stale agents and outbox effects")
    doctor.add_argument("--root-id")
    doctor.add_argument("--actor-token")

    metrics = commands.add_parser("metrics", help="report run-level runtime metrics")
    metrics.add_argument("--root-id")
    metrics.add_argument("--actor-token")

    history = commands.add_parser(
        "session-history", help="load one ACP conversation directly from its Agent"
    )
    history.add_argument("--agent-type", required=True)
    history.add_argument("--session-id", required=True)
    history.add_argument("--root-id")
    history.add_argument("--actor-token")

    prune = commands.add_parser("prune", help="delete old terminal runs")
    prune.add_argument("--older-than-hours", type=float, default=168.0)
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "init":
            tiers = json.loads(args.model_tiers_json) if args.model_tiers_json else None
            acp_args = json.loads(args.acp_args_json) if args.acp_args_json else None
            profile_allowlist = (
                json.loads(args.profile_allowlist_json)
                if args.profile_allowlist_json
                else None
            )
            _print(initialize_run(
                task=args.task,
                cwd=args.cwd,
                max_concurrent_agents=args.max_concurrent_agents,
                max_total_tasks=args.max_total_tasks,
                max_attempts_per_task=args.max_attempts_per_task,
                max_delegation_depth=args.max_delegation_depth,
                max_replans_per_task=args.max_replans_per_task,
                max_children_per_action=args.max_children_per_action,
                require_final_review=not args.no_final_review,
                model_tiers=tiers,
                backend=args.backend,
                acp_agent=args.acp_agent,
                acp_command=args.acp_command,
                acp_args=acp_args,
                acp_permission_policy=args.acp_permission_policy,
                profile_allowlist=profile_allowlist,
                default_profile=args.default_profile,
                entry_mode=args.entry_mode,
            ))
        elif args.command == "action":
            _action_command(args)
        elif args.command == "action-schema":
            _print(ACTION_SCHEMAS[args.action] if args.action else ACTION_SCHEMAS)
        elif args.command == "inspect":
            _inspect_command(args)
        elif args.command == "recover":
            root_id = args.root_id or _discover_root(args.cwd)
            context = recovery.recover_root(root_id, force_takeover=args.force_takeover)
            try:
                context["recovery"] = recovery.recover_run(root_id, context["actor_token"])
            except Exception as exc:
                context["recovery"] = {"ok": False, "error": str(exc)}
            try:
                context["side_effects"] = outbox.drain(root_id)
            except Exception as exc:
                context["side_effects"] = {"ok": False, "error": str(exc)}
            _print(context)
        elif args.command == "reap":
            root_id = _resolve(args.root_id, "AGENT_SWARM_ROOT_ID", "root_id")
            token = _resolve(args.actor_token, "AGENT_SWARM_ACTOR_TOKEN", "actor_token")
            kill_requests = [
                recovery.kill_stalled_attempt(root_id, token, attempt_id)
                for attempt_id in args.kill_attempt
            ]
            report = recovery.reap_children(root_id, token)
            report["kill_requests"] = kill_requests
            report["side_effects"] = outbox.drain(root_id)
            _print(report)
        elif args.command == "stop":
            root_id = _resolve(args.root_id, "AGENT_SWARM_ROOT_ID", "root_id")
            token = _resolve(args.actor_token, "AGENT_SWARM_ACTOR_TOKEN", "actor_token")
            _print(recovery.stop_run(root_id, token))
        elif args.command == "heartbeat":
            values = _identity_values(args)
            _refresh_run_hooks(values["root_id"], cwd=os.getcwd())
            _print(recovery.heartbeat(**values))
        elif args.command in {"bootstrap-cwd", "worktree-init"}:
            _bootstrap_cwd_command(args)
        elif args.command in {"doctor", "metrics"}:
            root_id = _resolve(args.root_id, "AGENT_SWARM_ROOT_ID", "root_id")
            token = _resolve(args.actor_token, "AGENT_SWARM_ACTOR_TOKEN", "actor_token")
            _authorize_read(root_id, token)
            _print(recovery.doctor(root_id) if args.command == "doctor" else recovery.metrics(root_id))
        elif args.command == "session-history":
            root_id = _resolve(
                args.root_id, "AGENT_SWARM_ROOT_ID", "root_id", required=False
            )
            records = session_history.find_records(
                args.agent_type, args.session_id, root_id=root_id
            )
            authorized_root = root_id or (records[0]["root_id"] if len(records) == 1 else None)
            if authorized_root:
                token = _resolve(
                    args.actor_token,
                    "AGENT_SWARM_ACTOR_TOKEN",
                    "actor_token",
                )
                _authorize_read(authorized_root, token)
            _print(
                session_history.load_history(
                    args.agent_type, args.session_id, root_id=root_id
                )
            )
        elif args.command == "prune":
            cutoff = state_store.now() - max(0, args.older_than_hours) * 3600
            with state_store.transaction() as con:
                rows = state_store.fetchall(
                    """SELECT root_id, cwd FROM runs
                       WHERE status IN ('done','failed','cancelled') AND finished_at < ?""",
                    (cutoff,), con,
                )
                pruned = []
                for row in rows:
                    hook_manager.cleanup_project_hooks(row["cwd"], root_id=row["root_id"])
                    cursor = con.execute(
                        """DELETE FROM runs WHERE root_id=?
                           AND status IN ('done','failed','cancelled') AND finished_at < ?""",
                        (row["root_id"], cutoff),
                    )
                    if cursor.rowcount == 1:
                        pruned.append(row["root_id"])
            _print({"pruned": len(pruned), "root_ids": pruned})
        return 0
    except (ValueError, RuntimeError, action_processor.ActionError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
