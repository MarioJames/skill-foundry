#!/usr/bin/env python3
"""Minimal Runtime surface invoked by the deployed Claude Hooks."""

import argparse
import json
import os


OWNER_LEASE_SECONDS = 15 * 60
IDENTITY_ENVIRONMENT = {
    "root_id": "ROOT_ID",
    "task_id": "TASK_ID",
    "attempt_id": "ATTEMPT_ID",
    "actor_token": "ACTOR_TOKEN",
}
CANONICAL_PREFIX = "AGENTS_ORCHESTRATOR_"
LEGACY_PREFIX = "AGENT_SWARM_"


def _environment_value(suffix):
    primary_name = CANONICAL_PREFIX + suffix
    legacy_name = LEGACY_PREFIX + suffix
    primary = os.environ.get(primary_name, "").strip() or None
    legacy = os.environ.get(legacy_name, "").strip() or None
    if primary and legacy and primary != legacy:
        raise ValueError(
            "conflicting orchestration environment: %s does not match %s"
            % (primary_name, legacy_name)
        )
    return primary or legacy


def _prepare_runtime_home():
    runtime_home = _environment_value("HOME")
    if runtime_home:
        os.environ[CANONICAL_PREFIX + "HOME"] = runtime_home
        os.environ[LEGACY_PREFIX + "HOME"] = runtime_home


_prepare_runtime_home()

# The deployed Hook bundle intentionally contains only this module plus the
# existing store/manager.  Keep its small compatibility bootstrap self-contained.
import hook_manager  # noqa: E402
import state_store  # noqa: E402


def _verify_owner(run, token):
    if not state_store.token_matches(token, run.get("owner_token_hash")):
        raise RuntimeError("invalid owner token")


def heartbeat(root_id, task_id, attempt_id, actor_token):
    with state_store.transaction() as con:
        run = state_store.get_run(root_id, con)
        task = state_store.get_task(task_id, con)
        attempt = state_store.get_attempt(attempt_id, con)
        if not all((run, task, attempt)):
            raise RuntimeError("invalid heartbeat binding")
        if not (
            task["root_id"] == root_id
            and attempt["root_id"] == root_id
            and attempt["task_id"] == task_id
        ):
            raise RuntimeError("invalid heartbeat binding")
        if not state_store.token_matches(actor_token, attempt["actor_token_hash"]):
            raise RuntimeError("invalid actor token")
        current = state_store.get_current_attempt(task_id, con)
        if current is None or current["attempt_id"] != attempt_id:
            return {"accepted": False, "stale_attempt": True}
        if run["status"] != "running" or attempt["state"] in {"done", "failed", "cancelled"}:
            return {"accepted": False, "terminal": True}
        timestamp = state_store.now()
        con.execute("UPDATE attempts SET heartbeat_at=? WHERE attempt_id=?", (timestamp, attempt_id))
        lease_expires_at = run.get("lease_expires_at")
        if task_id == run["root_task_id"]:
            _verify_owner(run, actor_token)
            if lease_expires_at and lease_expires_at < timestamp:
                raise RuntimeError("root owner lease expired; recover the run")
            lease_expires_at = timestamp + OWNER_LEASE_SECONDS
            con.execute(
                "UPDATE runs SET lease_expires_at=?, updated_at=? WHERE root_id=?",
                (lease_expires_at, timestamp, root_id),
            )
        return {
            "accepted": True,
            "heartbeat_at": timestamp,
            "lease_expires_at": lease_expires_at,
        }


def observe_session_end(root_id, task_id, attempt_id, actor_token):
    """Record SessionEnd without changing Attempt or Task lifecycle state."""
    with state_store.transaction() as con:
        run = state_store.get_run(root_id, con)
        task = state_store.get_task(task_id, con)
        attempt = state_store.get_attempt(attempt_id, con)
        if not all((run, task, attempt)):
            raise RuntimeError("invalid SessionEnd binding")
        if not (
            task["root_id"] == root_id
            and attempt["task_id"] == task_id
            and state_store.token_matches(actor_token, attempt["actor_token_hash"])
        ):
            raise RuntimeError("invalid SessionEnd identity")
        state_store.append_event(
            con, root_id, "SessionEndObserved", {"attempt_state": attempt["state"]},
            task_id=task_id, attempt_id=attempt_id,
        )
        return {"observed": True, "attempt_id": attempt_id, "state": attempt["state"]}


def _authorize_read(root_id, actor_token):
    state_store.initialize_schema()
    run = state_store.get_run(root_id)
    if run is None:
        raise ValueError("run not found")
    if not any(
        state_store.token_matches(actor_token, attempt["actor_token_hash"])
        for attempt in state_store.list_attempts(root_id)
    ):
        raise ValueError("invalid actor token")
    return run


def inspect_current(root_id, task_id, actor_token):
    run = _authorize_read(root_id, actor_token)
    task = state_store.get_task(task_id)
    if task is None or task["root_id"] != root_id:
        raise ValueError("current task does not belong to the authorized run")
    attempt = state_store.get_current_attempt(task_id)
    if attempt is None or attempt["root_id"] != root_id or attempt["task_id"] != task_id:
        raise ValueError("current attempt binding is invalid")
    launch = state_store.get_current_launch(attempt["attempt_id"])
    session = state_store.get_session_for_launch(launch["launch_id"]) if launch else None
    return {"run": run, "task": task, "attempt": attempt, "launch": launch, "session": session}


def _refresh_run_hooks(root_id, cwd):
    if state_store.get_run(root_id) is not None:
        hook_manager.ensure_project_hooks(cwd, root_id=root_id)


def _identity_from_environment():
    suffixes = tuple(IDENTITY_ENVIRONMENT.values())
    for prefix in (CANONICAL_PREFIX, LEGACY_PREFIX):
        present = [
            suffix
            for suffix in suffixes
            if os.environ.get(prefix + suffix, "").strip()
        ]
        if present and len(present) != len(suffixes):
            missing = [
                prefix + suffix for suffix in suffixes if suffix not in present
            ]
            raise ValueError(
                "partial orchestration identity: missing %s" % ", ".join(missing)
            )
    values = {
        key: _environment_value(suffix)
        for key, suffix in IDENTITY_ENVIRONMENT.items()
    }
    missing = [
        CANONICAL_PREFIX + IDENTITY_ENVIRONMENT[key]
        for key, current in values.items()
        if not current
    ]
    if missing:
        raise ValueError(
            "missing orchestration identity: %s" % ", ".join(missing)
        )
    for key, suffix in IDENTITY_ENVIRONMENT.items():
        os.environ[CANONICAL_PREFIX + suffix] = values[key]
        os.environ[LEGACY_PREFIX + suffix] = values[key]
    for key in ("task_id", "attempt_id"):
        try:
            values[key] = int(values[key])
        except (TypeError, ValueError) as exc:
            raise ValueError(
                "%s must be an integer"
                % (CANONICAL_PREFIX + IDENTITY_ENVIRONMENT[key])
            ) from exc
    return values


def main(argv=None):
    parser = argparse.ArgumentParser(prog="hook_runtime.py")
    parser.add_argument("command", choices=("heartbeat", "inspect-current", "session-end"))
    args = parser.parse_args(argv)
    try:
        values = _identity_from_environment()
        if args.command == "heartbeat":
            _refresh_run_hooks(values["root_id"], os.getcwd())
            result = heartbeat(**values)
        elif args.command == "inspect-current":
            result = inspect_current(
                values["root_id"], values["task_id"], values["actor_token"]
            )
        else:
            result = observe_session_end(**values)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ValueError, RuntimeError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
