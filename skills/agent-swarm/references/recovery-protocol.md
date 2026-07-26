# Recovery, child reaping, and stop protocol

## Recover a missing Root

Never call `init` for recovery intent. Invoke `recover` directly and let the Runtime resolve the
single recoverable Run:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py recover --cwd "$(pwd)"
```

Or specify the known Run:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py recover --root-id <root_id>
```

Zero or multiple matching Runs is an error and must not fall back to `init`. A live owner lease
prevents takeover; use `--force-takeover` only after confirming the old foreground owner is gone.

Recovery cancels the prior live Root Attempt, appends a new Root Attempt, rotates the actor token,
increments the lease epoch, and keeps the same Run and root Task. It does not create an `agent_id` or
reuse the old Attempt.

## Reap children while Root is healthy

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py reap \
  --root-id "$AGENT_SWARM_ROOT_ID" \
  --actor-token "$AGENT_SWARM_ACTOR_TOKEN"
```

`reap` does not replace the Root identity. It:

- recovers stale Effect claims;
- observes each current child Launch without holding a database write transaction;
- closes terminal Attempts' Launches only after backend absence is proven;
- converts a closed/ended Launch with an unfinished Attempt into one retryable failure;
- leaves unknown or contradictory backend facts unchanged;
- reports a present child whose Attempt heartbeat is older than five minutes;
- schedules ready Tasks after reconciliation.

An unready starting ACP Launch remains assigned so the ACP adapter can apply its bounded startup
grace. Only after Worker, Agent process, and socket are all absent does it close the old Launch and
append a replacement. Launch rows are never advanced in place.

Root `wait` invokes this watchdog immediately and at most every 30 seconds while waiting.

To stop and retry a diagnosed child:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py reap \
  --root-id "$AGENT_SWARM_ROOT_ID" \
  --actor-token "$AGENT_SWARM_ACTOR_TOKEN" \
  --kill-attempt <attempt_id>
```

The Runtime marks the Attempt failed, fences its current Launch, emits one idempotent stop Effect,
and schedules the new Attempt only after stop completes.

## Inspect

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py inspect --run <root_id>
python3 <skill_dir>/scripts/agent_orchestrator.py doctor --root-id <root_id>
python3 <skill_dir>/scripts/agent_orchestrator.py metrics --root-id <root_id>
```

Full inspection returns Tasks, Attempts, Launches, ACP Sessions, and Effects. This is enough to
reconstruct the logical tree and every execution attempt. It intentionally does not include local
conversation history.

For ACP history, query the actual Agent store:

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py session-history \
  --agent-type <agent-type> \
  --session-id <external-session-id> \
  --actor-token <actor-token>
```

If the Agent no longer has the Session, the command returns `available: false` with
`reason: session_missing`; no recovery or retry is triggered.

## Stop a Run

```bash
python3 <skill_dir>/scripts/agent_orchestrator.py stop \
  --root-id <root_id> \
  --actor-token <root_actor_token>
```

Stop fences every open Launch, including an ACP Worker that has not reached `session/new`, cancels
live Attempts and Tasks, and emits one stop Effect per Launch. The Run becomes `cancelled` only when
all Launch resources are closed. If the result remains `stopping`, retry stop or inspect failed
Effects and open Launches.

After `status: cancelled`, do not submit more business Actions for that Run.

`SessionEnd` and ACP turn end remain observations. They never forge Task completion. Heartbeats come
from Actions, Claude Hooks, the explicit heartbeat command, and the ACP Worker.
