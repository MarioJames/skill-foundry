# Jev task scheduling

Use this route for a concrete multi-task workload where selecting task waves and execution models helps. The main Agent plans and integrates; Jev chooses among bounded proposals; Herdr owns Agent resources. A status question, small coupled edit, or already determined assignment does not need an extra model call.

## Branch the workflow

1. **Prepare task units.** Give each unit an outcome, available inputs, artifact, acceptance condition, dependency IDs and read/write ownership. Keep interfaces and architecture decisions with their owner until downstream tasks have sufficient inputs. Split only when execution savings exceed handoff and integration cost; do not split merely to fill all slots.
2. **Resolve unknowns.** Read the needed evidence. Record remaining uncertainty explicitly. Unknown write ownership is not an empty write set: set that unit to `blocked` until ownership is established. Units without sufficient inputs also remain `blocked`; a failed attempt stays `failed` until its evidence has been inspected. Nonblocking uncertainties may remain on a pending task for Jev to evaluate; the free-text uncertainty list does not mechanically block every task.
3. **Offer the next wave.** Use the runtime's current model inventory and remaining capacity. Provide a small set of materially different plans, such as two independent units on Luna, a mixed-model pair, or one unit first. Include stronger-model alternatives where their capability is warranted. Do not enumerate every task/model permutation. Plans describe immediate dispatches, not a whole future sequence.
4. **Select.** Run the script below. Dependencies must be `done`; running tasks consume capacity and reserve resources. Known conflicts eliminate a plan before Jev sees its option. Jev judges semantic independence and capability against the supplied facts. A serial plan can win even when a parallel plan passes mechanical checks.
5. **Dispatch and record.** Recheck the snapshot against live state. Route each selected task to an existing suitable Agent or a new lane, explicitly use its model, and record task ID, actual model, pane/Agent IDs, cwd, revision and cleanup command in the existing private task record. No new global registry is needed. Start independent units before waiting on one; respect runtime capacity, including the main Agent and unrelated active work.
6. **Accept, integrate, repeat.** Inspect the artifact and relevant checks; Agent completion alone is not acceptance. Integrate results or provide a verified artifact in the dependent task's cwd before changing status to `done`. Refresh the batch and select the next wave. The main Agent performs final integrated verification and releases only task-owned resources.

One main Agent owns scheduling for a batch. The script is stateless: it does not reserve slots, start Agents or lock a shared queue. Do not run concurrent decision/dispatch loops for the same batch. A second scheduler requires coordination outside this script.

For isolated code changes, prepare/reuse a baseline and create views through `cow-workspace`, then pass their actual `cwd` to the lane router. Directory isolation does not settle interface dependencies, integration conflicts, migrations or shared database writes. In a shared cwd, serialize Git/index operations, dependency installation and shared build outputs, or keep them with the main Agent; disjoint source files alone do not isolate these operations.

## Input and context budget

Start from [`examples/jev-batch.json`](../examples/jev-batch.json). Its paths and model inventory are illustrative: replace them with actual paths and models available and authorized in the current runtime. Model IDs are the exact IDs used to launch the execution Agent, not aliases such as `cheap` or provider guesses. The Jev decision model is separate and fixed to the requested OpenRouter alias.

Required fields:

| Field | Meaning |
| --- | --- |
| `goal`, `constraints` | Current outcome and concise hard requirements; exclude unrelated history |
| `max_concurrency` | Total allowed simultaneous task units in this batch, including its running tasks; account for other runtime usage before setting it |
| `models[]` | At most 8 available models with `id`, Herdr `agent` kind and task-relevant capability/cost `description` |
| `tasks[]` | At most 32 relevant tasks, including dependency and running-task context |
| task `id`, `status`, `cwd` | Stable identifier, `pending/running/done/failed/blocked`, absolute execution directory |
| task `summary`, `inputs`, `deliverable`, `acceptance` | The bounded work, supplied facts, expected artifact and observable success criteria |
| task `uncertainties`, `depends_on` | Explicit unknowns and dependency IDs present in this batch; cycles are rejected |
| task `reads`, `writes` | Canonical resource keys; empty arrays explicitly mean no such access |
| task `allowed_models` | The subset of declared models permitted for this unit; do not override a user-specified model |
| `plans[]` | At most 12 proposals, each with `id`, `description`, and unique `{task_id, model_id}` assignments |

Resource keys are case-sensitive, slash-separated identifiers with no globs, empty segments, `.` or `..`. A parent key overlaps its descendants: `repo/project/src` covers `repo/project/src/date`. Write/write and write/read intersections conflict; read/read does not. Use the same canonical key for the same actual resource across all tasks, including aliases, symlinks and differently cased paths on insensitive filesystems. Include running work outside the batch as resource reservations in your planning or exclude affected tasks; this script cannot inspect external schedulers.

Examples: `repo/project/src/date`, `git/project`, `build/project`, `db/dev/orders`, `redis/dev/jobs`. Cover all writes produced by the deliverable, including tests and writable caches. The example assigns separate source/test paths and keeps test execution, Git and shared build/cache writes with the main Agent. For independent CoW views, use distinct filesystem keys; use the same external-service keys if they share a database or Redis namespace. Do not rename a shared resource simply to make a plan pass. Mechanical checks only cover declared facts.

Keep the current batch and directly relevant facts. Condense old completed tasks to evidence needed by dependents, without removing referenced dependency IDs. Keep raw files/logs and artifact locations in the existing task record; Jev does not retrieve referenced files. Unknown fields are rejected to catch schema mistakes and discourage dumping arbitrary context.

The script checks both the input and the full generated request, including instructions and options, against **24,000 UTF-8 bytes**. This is a deliberately conservative operational budget under the model's advertised 32K context, not an exact tokenizer count or a claim that every provider serializes identically. Oversized input is rejected intact: reduce the wave or summarize evidence, retaining constraints and uncertainty. The JSON file itself is capped at 64,000 bytes. No silent truncation, automatic summarization model or tokenizer dependency is added.

## Call and consume

Set `OPENROUTER_API_KEY` through the existing private environment mechanism. Do not put credentials in the JSON, command-line arguments, Git or task descriptions. The script reads this environment variable; it does not search private files. Bun's usual environment loading still applies unless invoked with `--no-env-file`.

```bash
bun <skill-dir>/scripts/decide-tasks.ts --input /private/task/batch.json --dry-run
bun <skill-dir>/scripts/decide-tasks.ts --input /private/task/batch.json
```

Dry run prints the exact provider payload for review and never calls the API. Its output contains task context; keep it in private task evidence. Live mode makes one POST to `https://openrouter.ai/api/alpha/decisions`, using `model: "~typesafe/jev-latest"`, `state` and a typed `choice` question named `schedule`. It does not use chat completions. Each candidate binds task grouping to exact model assignments; reserved choices `need_context` and `escalate` provide explicit exits.

Successful output contains `snapshot_id`, `status`, `plan_id`, `can_parallel`, `assignments`, and `rejected_plans`. Each selected assignment includes `task_id`, `model_id`, `agent`, and `cwd`. `can_parallel` means this proposal contains multiple simultaneous new assignments; running tasks are still counted separately. The snapshot hash identifies the supplied input, not the actual live workspace or an execution reservation. Refresh input and rerun if state, ownership, constraints or availability changed before dispatch. Reformatting JSON keys can also change the hash; there is no decision cache.

| Status | Branch |
| --- | --- |
| `selected` | Recheck live state and execute the offered proposal within existing authorization |
| `need_context` | Main Agent gathers the missing facts or clarifies material user intent; do not start assignments |
| `escalate` | Main Agent revises decomposition/model choices or handles the work itself |
| `wait` | No feasible offered plan while tasks are running; collect their results and continue independent work |
| `complete` | Every supplied task is marked done; still verify full-goal coverage and final integration |
| `dry_run` | Inspection only; not a scheduling decision |

Only `ok=true` **and** `status=selected` carries executable assignments. `wait`, `complete`, and locally determined `escalate` need no API key or remote call. Invalid input, missing credentials, invalid replies and network/provider errors produce `ok=false`, a structured error, and a nonzero exit. They never dispatch, retry or silently substitute a model. Provider error bodies are omitted so they cannot echo secrets or task text. The default network deadline is 20 seconds; `--timeout-ms` supports 1–120000.

The default `--min-confidence 0.8` is an **uncalibrated local escalation policy**, not a correctness probability. Below it, output has no assignments and status `escalate`. Missing or invalid confidence is a response error. Tune the policy only with labeled task outcomes; do not lower it merely to obtain a desired decision. Actual API `resolved_model`, confidence and validated token/cost `usage` are returned for evaluation because the `latest` alias can change. Missing or malformed required token accounting is treated as an incompatible response.

## Herdr handoff and failure branches

Use the existing lane router for new resources, with the assigned cwd and normal naming rules. Consult `herdr agent start --help` for the installed runtime; use the chosen Agent's documented model flag. For Codex, a typical launch after receiving the pane ID is:

```bash
herdr agent start TASK_NAME --kind codex --pane PANE_ID -- --model MODEL_ID
```

For a reused Agent, verify its actual model and state before sending a new task. The decision is not permission to interrupt unrelated work or silently change a model. Give each delegate the task's full execution context and artifact references; the compact Jev batch is not a substitute for a usable worker prompt. Include write ownership, validation, caller/destination IDs, naming ownership and handoff requirements.

Mark a successfully started and submitted task `running` before dispatching another wave. If only part of a wave starts, keep those units running, record the failed launch and recompute remaining capacity; do not replay the entire wave. Unknown submission status requires inspecting the same Agent, not creating a duplicate. If a worker fails, retain its useful evidence and mark `failed`; the main Agent decides whether to unblock a corrected retry, propose a stronger model, or revise dependencies. Do not add an unbounded retry/escalation loop.

After acceptance, record artifacts and validation, then clean lanes through their returned cleanup commands. Export/integrate CoW changes before workspace removal and follow its persistent-data rules. Keep existing task records and required data; closing a lane does not remove a CoW workspace.

## Validation and protocol sources

```bash
bun test <skill-dir>/tests
bun <skill-dir>/scripts/decide-tasks.ts --input <skill-dir>/examples/jev-batch.json --dry-run
```

The tests exercise policy branches and the real CLI with the HTTP boundary replaced. They do not establish Jev routing accuracy or runtime availability of the example models. An authenticated smoke call is separate evidence.

Protocol checked against [OpenRouter's Decisions implementation](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/funcs/alphaDecisionsCreate.ts), [request schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/decisionsrequest.ts), [choice answer schema](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/models/decisionschoiceanswer.ts), and [Jev model alias](https://openrouter.ai/~typesafe/jev-latest). The endpoint is alpha; incompatible responses fail explicitly instead of being parsed as chat text.
