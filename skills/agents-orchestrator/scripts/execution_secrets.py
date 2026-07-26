"""Run-scoped child token seeds and deterministic Attempt token derivation."""

import base64
import hashlib
import hmac
import os
import pathlib

import state_store


SEED_BYTES = 32


def _secret_root():
    root = state_store.runtime_root() / "secrets"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(str(root), 0o700)
    return root.resolve()


def seed_ref(root_id):
    return "secrets/%s.key" % root_id


def resolve_seed_path(reference):
    if not isinstance(reference, str) or not reference:
        raise RuntimeError("Run child token seed reference is missing")
    relative = pathlib.PurePosixPath(reference)
    if relative.is_absolute() or ".." in relative.parts or relative.parts[:1] != ("secrets",):
        raise RuntimeError("Run child token seed reference is invalid")
    path = (state_store.runtime_root() / pathlib.Path(*relative.parts)).resolve()
    if path.parent != _secret_root():
        raise RuntimeError("Run child token seed escapes the secret directory")
    return path


def create_run_seed(root_id):
    reference = seed_ref(root_id)
    path = resolve_seed_path(reference)
    seed = os.urandom(SEED_BYTES)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(str(path), flags, 0o600)
    try:
        os.write(descriptor, seed)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(str(path), 0o600)
    return reference, hashlib.sha256(seed).hexdigest()


def _read_seed(run):
    path = resolve_seed_path(run.get("token_seed_ref"))
    try:
        mode = path.stat().st_mode & 0o777
        if mode != 0o600:
            raise RuntimeError("Run child token seed must have mode 0600")
        seed = path.read_bytes()
    except OSError as exc:
        raise RuntimeError("Run child token seed is unavailable") from exc
    if len(seed) != SEED_BYTES:
        raise RuntimeError("Run child token seed has an invalid length")
    expected = run.get("token_seed_hash")
    if not expected or not hmac.compare_digest(hashlib.sha256(seed).hexdigest(), expected):
        raise RuntimeError("Run child token seed hash does not match")
    return seed


def derive_attempt_token(run, attempt_id):
    seed = _read_seed(run)
    message = "%s|%s" % (run["root_id"], attempt_id)
    digest = hmac.new(seed, message.encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def remove_run_seed(run):
    reference = run.get("token_seed_ref") if run else None
    if not reference:
        return True
    path = resolve_seed_path(reference)
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    return not path.exists()


def cleanup_run_seed_if_safe(root_id):
    with state_store.transaction(immediate=False) as con:
        run = state_store.get_run(root_id, con)
        if run is None or run["status"] not in {"done", "failed", "cancelled"}:
            return False
        open_effects = con.execute(
            """SELECT COUNT(*) AS n FROM effects
               WHERE root_id=? AND effect_type IN ('spawn_agent','stop_agent')
                 AND status IN ('pending','running')""",
            (root_id,),
        ).fetchone()["n"]
        open_executions = con.execute(
            """SELECT COUNT(*) AS n FROM launches l
               JOIN attempts a ON a.attempt_id=l.attempt_id
               JOIN tasks t ON t.task_id=a.task_id
               WHERE t.root_id=? AND l.status != 'closed'""",
            (root_id,),
        ).fetchone()["n"]
    if open_effects or open_executions:
        return False
    return remove_run_seed(run)
