# Recovery, child reaping, and stop protocol

## Recover a missing Root instead of reinitialize

**NEVER** call `init` for recovery intent. **ALWAYS** invoke `recover` and let the Runtime decide whether a
Run is recoverable. **DO NOT** query SQLite, inspect internal tables, or infer recoverability before
calling the command.

When the Run ID is unknown, discover the single recoverable Run for the current working directory:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py recover --cwd "$(pwd)"
```

When the Run ID is known, use it explicitly:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py recover \
  --root-id <root_id>
```

If the current directory has zero or multiple recoverable Runs, the command fails without creating
a Run. Report that result as-is; **DO NOT** fall back to `init`.

A live owner lease prevents accidental takeover. Use `--force-takeover` only when the prior
foreground owner is known to be gone. Recovery creates a new Root Attempt and actor token; it **NEVER**
reuses the previous Session's Attempt.

Recovery creates a new Root Attempt. It is not a child watchdog and **MUST NOT** be used while the
foreground Root is still healthy.

## Reap stale children while the Root is healthy

Use `reap` with the current Root identity. It **NEVER** changes the Root Attempt, owner token, or lease
epoch:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py reap \
  --root-id "$AGENT_SWARM_ROOT_ID" \
  --actor-token "$AGENT_SWARM_ACTOR_TOKEN"
```

Root `wait` runs this child watchdog immediately and then at most once every 30 seconds, returning
its diagnostics to the Parent. `reap` remains available for an immediate manual check or a
Parent-selected kill.

For a running child, the watchdog applies this bounded policy:

- a heartbeat newer than five minutes is kept;
- after five minutes, a successful `claude agents --json` observation that has no matching `job_id`
  or `session_name` marks the old Attempt retryable and dispatches a new Attempt within its budget;
- after five minutes, a live matching Session is reported in `stalled_agents` for the Parent to
  diagnose; it is not silently kept forever and it is not automatically killed;
- an unavailable or malformed session observation changes nothing and is reported in
  `session_observation_errors`.

`state.json` under Claude's job directory is diagnostic-only; it cannot override a successful
`agents --json` absence observation. A child that has not yet reached its first live session is
handled by launch/outbox recovery, not this running-child watchdog.

After inspecting a reported stalled child, the Parent may choose a bounded kill-and-retry:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py reap \
  --root-id "$AGENT_SWARM_ROOT_ID" \
  --actor-token "$AGENT_SWARM_ACTOR_TOKEN" \
  --kill-attempt <attempt_id>
```

The Runtime invalidates that old Attempt, stops its Session through the outbox, then schedules the
retry. **DO NOT** use `--force-takeover` for this path.

Agent Swarm itself does not create worktrees. It records `.claude/settings.local.json` in
`.worktreeinclude` for future Claude-created worktrees and refreshes currently registered ones on
child launch, Action, and heartbeat. Every child **MUST** run `worktree-init` in the exact worktree
before substantial work, and again immediately after entering another worktree:

```bash
python3 "$AGENT_SWARM_SKILL_DIR/scripts/agent_orchestrator.py" worktree-init
```

The command authenticates the injected identity, refreshes its heartbeat, and merges the local Hook
settings. A missing worktree Hook configuration is a deployment issue to fix before treating an
otherwise-live Session's stale heartbeat as evidence to kill it.

Inspect before continuing:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py inspect --run <root_id>
python3 <skill_dir>/scripts/agent_orchestrator.py doctor --root-id <root_id>
```

Pass or export the newly returned identity/token for subsequent Root Actions. **DO NOT** repeat work
already proven done by current Task results.

## Stop

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py stop \
  --root-id <root_id> \
  --actor-token <root_actor_token>
```

Stop marks the Run stopping, cancels unfinished Tasks and live Attempts, emits idempotent stop
effects for live Sessions, and then marks the Run cancelled. If cleanup is incomplete, retry stop
or diagnose the failed stop effects. Once stop reports `terminal: true`, **DO NOT** execute more business
Actions for that Run.

SessionEnd is observation only. It **NEVER** forges Task completion or makes the Runtime reuse an
Attempt. Heartbeats come from Actions, the SessionStart/PostToolUse hooks, and the explicit
`heartbeat` command. The Stop hook can request a missing `finish`, but **NEVER** writes a terminal
state itself.
