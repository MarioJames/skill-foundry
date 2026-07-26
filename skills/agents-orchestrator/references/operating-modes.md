# Persistent operating modes

Runtime modes are persistent state machines compiled onto the ordinary Task tree. They use the
same Run, Attempts, scheduling, recovery, and `finish` gates; they are Actions, not `init --mode`
flags or separate Runtimes.

| Explicit user wording / CLI hint | Persisted `entry_mode` | Required `start_mode.mode` |
| --- | --- | --- |
| `swarm mode`, legacy `agent-swarm`, `--entry-mode swarm` | `swarm` | `swarm` |
| `loop mode`, `develop-review-improve`, `--entry-mode loop` | `develop_review_improve` | `develop_review_improve` |
| `multi-agent review`, `--entry-mode review` | `multi_session_review` | `multi_session_review` |
| `$agents-orchestrator` without a recipe | null | the Root selects one from the explicit goal |

Natural-language activation loads the skill; it does not mutate Runtime state by itself. `init`
persists the recipe hint, then the Root submits `submit_estimate` and a matching `start_mode`
Action. The Action is the only event that creates a mode state machine and compiles its Tasks.

Submit an estimate before starting a mode; use `strategy=split` when the owner needs the `wait`
Action. Query `action-schema start_mode` and `action-schema advance_mode`; never infer a payload
from these examples alone.

## Contents

- [Evidence propagation](#evidence-propagation)
- [Swarm](#swarm)
- [Develop-review-improve loop](#develop-review-improve-loop)
- [Swarm to loop to review](#swarm-to-loop-to-review)
- [Cancel](#cancel)
- [Legacy agent-swarm alias](#legacy-agent-swarm-alias)

## Evidence propagation

Task dependency edges gate scheduling but do not themselves place upstream `result_json` in a
downstream prompt. The mode compiler injects `[MODE CONTEXT]` containing
`assignment.dependency_evidence_bundle` with:

```json
{"sha256":"<hash-of-unabridged-canonical-json>","bytes":1234,"truncated":false,"content":"<bounded canonical JSON>"}
```

The bundle covers base evidence, dependency results, the assigned candidate, and finding
provenance; content is capped at 12,000 bytes while the hash and byte count always describe the
full canonical payload. When that payload is oversized, `content` is a deterministic
`sectioned-canonical-json-v1` envelope. It gives candidate, dependencies, and provenance separate
hashed previews before allocating remaining space to base evidence, so an oversized base cannot
hide those consensus inputs. Each section reports its own unabridged hash, byte count, and
truncation state. This is mandatory for persistent reviewers and verifiers. Do not rely on
dependency edges or ask an ACP `allow_in_workspace` child to recover evidence with general Runtime
`inspect`; that command is outside the narrow headless control exception.

## Swarm

Start an executable fan-out after the Root estimate (replace `<skill_dir>`):

```bash
printf '%s' '{"mode":"swarm","objective":"Implement and validate the feature","tasks":[{"key":"implementation","goal":"Implement the scoped feature","intent_hint":"implement","complexity_hint":"medium","model_tier_hint":"balanced","priority":60,"output_contract":"Changed files, validation, and mode_result evidence","constraints":{"write_scope":["src/**"],"read_only":false,"notes":[]},"depends_on":[]},{"key":"tests","goal":"Add independent acceptance tests","intent_hint":"implement","complexity_hint":"medium","model_tier_hint":"balanced","priority":50,"output_contract":"Tests, command output, and mode_result evidence","constraints":{"write_scope":["tests/**"],"read_only":false,"notes":[]},"depends_on":[]}],"config":{"max_tasks":8,"max_seconds":1800},"evidence":{}}' | python3 <skill_dir>/scripts/agent_orchestrator.py action --type start_mode --stdin
```

Each compiled child finishes with normal fields plus
`"mode_result":{"status":"done","evidence":[...]}`. After returned Tasks are terminal, advance
the mode; it completes only when every compiled Task is done:

```bash
printf '%s' '{"mode_id":<mode_id>,"operation":"advance","reason":"children terminal"}' | python3 <skill_dir>/scripts/agent_orchestrator.py action --type advance_mode --stdin
```

## Develop-review-improve loop

The Runtime creates one developer and a separate read-only deterministic validator before the
independent reviewer. Every `changes_requested` candidate receives distinct reproduce and falsify
verifier Tasks before any improver exists. Only Runtime-adjudicated confirmed fingerprints reach
the improver; all-rejected findings complete without a fix, while high/critical unresolved
findings block. A changed improvement always receives read-only deterministic revalidation before
the next independent re-review. `pass` completes; validation failure, no progress, deadline, task
budget, or `max_rounds` closes with an explicit terminal outcome.

```bash
printf '%s' '{"mode":"develop_review_improve","objective":"Implement the change and converge on independent review","config":{"phases":["develop","validate","review","verify","improve","revalidate","re_review"],"exit_conditions":{"passed":"clean_review","validation_failure":"blocked","high_severity_unresolved":"blocked","max_rounds":"budget_exhausted","no_progress":"no_progress"},"max_rounds":3,"max_tasks":18,"max_seconds":3600,"max_no_progress":2},"evidence":{"request":"<bounded source requirement>"}}' | python3 <skill_dir>/scripts/agent_orchestrator.py action --type start_mode --stdin
```

Call `advance_mode` after each returned phase Task is terminal. Mode Tasks must include the role's
required `mode_result`: developer `summary` plus evidence; validator/revalidator `stage`, `status`,
`artifact_version`, commands, and evidence; reviewer `verdict` and standard findings; verifier
candidate verdict plus evidence; and improver `changed`, `addressed_fingerprints`, and evidence.
The v1 preset accepts only the declared canonical phase order and exit-condition contract; unknown
or inert config fields are rejected rather than silently ignored. Task dependency rows persist the
actual phase edges.

## Swarm to loop to review

Compose modes from a mode-owned child while its parent is still running. Parent links are inferred
for a mode Task; an explicit `parent_mode_id` must match that ownership. The depth guard rejects
cycles and excessive nesting.

This executable top-level swarm creates a pipeline owner. Its dependency evidence is injected; the
owner starts a nested `develop_review_improve`, and that loop's reviewer starts
`multi_session_review` before returning its verdict:

```bash
printf '%s' '{"mode":"swarm","objective":"Swarm->loop->review delivery pipeline","tasks":[{"key":"discovery","goal":"Discover implementation constraints","intent_hint":"research","complexity_hint":"medium","model_tier_hint":"balanced","priority":70,"output_contract":"Constraints and mode_result evidence","constraints":{"write_scope":[],"read_only":true,"notes":[]},"depends_on":[]},{"key":"pipeline","goal":"Use injected discovery evidence; start a nested develop_review_improve mode. In its review phase, start nested multi_session_review consensus before reporting the loop verdict. Finish only after both nested modes succeed.","intent_hint":"integrate","complexity_hint":"high","model_tier_hint":"strong","priority":80,"output_contract":"Converged implementation, consensus, and mode_result evidence","constraints":{"write_scope":["src/**","tests/**"],"read_only":false,"notes":[]},"depends_on":[{"task_key":"discovery","condition":"success"}]}],"config":{"max_mode_depth":4,"max_tasks":40,"max_seconds":7200},"evidence":{}}' | python3 <skill_dir>/scripts/agent_orchestrator.py action --type start_mode --stdin
```

Advance each owned mode through the Runtime. A Task cannot finish done while one of its owned modes
is blocked, failed, or still running.

## Cancel

Cancellation is explicit and bounded:

```bash
printf '%s' '{"mode_id":<mode_id>,"operation":"cancel","reason":"user stopped the mode"}' | python3 <skill_dir>/scripts/agent_orchestrator.py action --type advance_mode --stdin
```

## Legacy `agent-swarm` alias

The alias defaults user intent to swarm but only execs the sibling canonical entrypoint. It does
not initialize automatically, create another database, or carry a Runtime copy. Install both
packages, then the legacy command remains executable:

```bash
python3 <skills_root>/agent-swarm/scripts/agent_orchestrator.py init \
  --task "Legacy agent-swarm request: use swarm mode for the goal" --cwd "$(pwd)"
```

With an injected identity, use the same alias entrypoint only for `bootstrap-cwd`, schemas, and
Actions; never call `init`:

```bash
python3 <skills_root>/agent-swarm/scripts/agent_orchestrator.py action-schema start_mode
```

For `init`, the wrapper exports equal canonical/legacy `MODE=swarm`; canonical `init` persists and
returns `entry_mode: "swarm"`. The foreground Root must still estimate and submit `start_mode`, so
the alias cannot initialize or schedule a second Run.
