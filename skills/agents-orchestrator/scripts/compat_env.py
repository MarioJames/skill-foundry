"""Canonical environment names with strict Agent Swarm compatibility.

The Runtime still has integration points that read ``AGENT_SWARM_*`` directly
(notably the persisted SQLite runtime and older entrypoints).  New callers use
``AGENTS_ORCHESTRATOR_*``.  This module keeps resolution in one place:

* canonical values are primary;
* a non-empty legacy value is an accepted fallback;
* conflicting dual definitions and partial identities fail closed;
* child/process boundaries can deliberately export both families.

The default runtime home and SQLite filename remain the existing values until
``state_store`` can consume this helper directly.  Keeping those defaults here
makes that later integration explicit and avoids silently stranding persisted
Runs during the package rename.
"""

from contextlib import contextmanager
import os
import pathlib


CANONICAL_PREFIX = "AGENTS_ORCHESTRATOR_"
LEGACY_PREFIX = "AGENT_SWARM_"
RUNTIME_HOME_DIRECTORY = ".agent-swarm"
RUNTIME_SQLITE_FILENAME = "runtime.sqlite3"

IDENTITY_SUFFIXES = (
    "ROOT_ID",
    "TASK_ID",
    "ATTEMPT_ID",
    "ACTOR_TOKEN",
)
BOUNDARY_SUFFIXES = IDENTITY_SUFFIXES + (
    "HOME",
    "SKILL_DIR",
)
TRANSIENT_IDENTITY_SUFFIXES = (
    "AGENT_ID",
    "EXECUTION_NONCE",
)


def canonical_name(suffix):
    return CANONICAL_PREFIX + suffix


def legacy_name(suffix):
    return LEGACY_PREFIX + suffix


def _nonempty(environment, name):
    value = environment.get(name)
    if isinstance(value, str):
        value = value.strip()
    return None if value is None or value == "" else value


def value(suffix, environment=None, default=None):
    """Resolve canonical > legacy while rejecting unequal dual definitions."""
    environment = os.environ if environment is None else environment
    primary_name = canonical_name(suffix)
    fallback_name = legacy_name(suffix)
    primary = _nonempty(environment, primary_name)
    fallback = _nonempty(environment, fallback_name)
    if primary is not None and fallback is not None and primary != fallback:
        raise ValueError(
            "conflicting orchestration environment: %s does not match %s"
            % (primary_name, fallback_name)
        )
    return primary if primary is not None else fallback if fallback is not None else default


def validate_identity(environment=None):
    """Reject a partially populated identity family, even if the other is full."""
    environment = os.environ if environment is None else environment
    for prefix in (CANONICAL_PREFIX, LEGACY_PREFIX):
        present = [
            suffix
            for suffix in IDENTITY_SUFFIXES
            if _nonempty(environment, prefix + suffix) is not None
        ]
        if present and len(present) != len(IDENTITY_SUFFIXES):
            missing = [
                prefix + suffix
                for suffix in IDENTITY_SUFFIXES
                if suffix not in present
            ]
            raise ValueError(
                "partial orchestration identity: missing %s" % ", ".join(missing)
            )
    return {
        suffix: value(suffix, environment)
        for suffix in IDENTITY_SUFFIXES
    }


def promote_canonical_environment(environment=None):
    """Make canonical-only process values visible to legacy integration code.

    Legacy-only environments are intentionally not mirrored as an import side
    effect.  Boundary exporters perform symmetric dual-family export.
    """
    environment = os.environ if environment is None else environment
    validate_identity(environment)
    suffixes = set(BOUNDARY_SUFFIXES)
    suffixes.update(
        name[len(CANONICAL_PREFIX) :]
        for name in tuple(environment)
        if name.startswith(CANONICAL_PREFIX)
        and len(name) > len(CANONICAL_PREFIX)
    )
    for suffix in sorted(suffixes):
        primary = _nonempty(environment, canonical_name(suffix))
        fallback = _nonempty(environment, legacy_name(suffix))
        if primary is not None and fallback is not None and primary != fallback:
            value(suffix, environment)  # raises the stable conflict diagnostic
        if primary is not None and fallback is None:
            environment[legacy_name(suffix)] = primary
    return environment


def export_both(values, *, base=None, scrub_identity=False):
    """Return an environment fragment with canonical and legacy names.

    ``values`` uses suffix keys such as ``ROOT_ID`` and ``HOME``.  When
    ``scrub_identity`` is true, stale identity/transient values are removed
    from a copied base environment before the supplied binding is exported.
    """
    result = dict(base or {})
    if scrub_identity:
        for suffix in IDENTITY_SUFFIXES + TRANSIENT_IDENTITY_SUFFIXES:
            result.pop(canonical_name(suffix), None)
            result.pop(legacy_name(suffix), None)
    for suffix, raw in values.items():
        if raw is None:
            continue
        rendered = str(raw)
        result[canonical_name(suffix)] = rendered
        result[legacy_name(suffix)] = rendered
    return result


@contextmanager
def process_boundary(values):
    """Temporarily install an exact dual-family child identity in ``os.environ``."""
    names = [
        prefix + suffix
        for prefix in (CANONICAL_PREFIX, LEGACY_PREFIX)
        for suffix in IDENTITY_SUFFIXES + TRANSIENT_IDENTITY_SUFFIXES
    ]
    names.extend(
        prefix + suffix
        for prefix in (CANONICAL_PREFIX, LEGACY_PREFIX)
        for suffix in ("HOME", "SKILL_DIR")
    )
    before = {name: os.environ.get(name) for name in names}
    try:
        for name in names:
            os.environ.pop(name, None)
        os.environ.update(export_both(values))
        yield
    finally:
        for name in names:
            os.environ.pop(name, None)
        for name, prior in before.items():
            if prior is not None:
                os.environ[name] = prior


def runtime_home(environment=None):
    """Resolve the compatibility runtime home used by the current SQLite layer."""
    environment = os.environ if environment is None else environment
    configured = value("HOME", environment)
    if configured:
        return pathlib.Path(configured).expanduser().resolve()
    return (pathlib.Path.home() / RUNTIME_HOME_DIRECTORY).resolve()


def runtime_sqlite_path(environment=None):
    """Return the current compatibility SQLite path for future store integration."""
    return runtime_home(environment) / RUNTIME_SQLITE_FILENAME


# Names intentionally mirror state_store's current integration surface.
def runtime_root(environment=None):
    return runtime_home(environment)


def db_path(environment=None):
    return runtime_sqlite_path(environment)
