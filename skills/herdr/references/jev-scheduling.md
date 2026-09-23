# Configured heterogeneous scheduling

Use this workflow when independently deliverable tasks make delegation worthwhile. Keep tightly coupled or ordinary single-owner work direct. The main Agent owns decomposition, authorization, evidence, acceptance and integration; Jev supplies bounded decisions.

## One configuration

Copy and edit [`examples/agents.json`](../examples/agents.json) to `~/.config/herdr/agents.json`, or pass `--config PATH`. This is one complete file, with no merging, environment overrides or inferred model fallback. Creating a user-wide config requires authorization; using an explicit task-local file does not.

- `engines`: stable IDs, canonical `codex` or `qodercli` adapter, and `max_parallel`. V1 permits one instance per adapter. Renaming an ID does not reset old adapter reservations.
- `routes`: exactly `ordinary`, `moderate`, `complex`; each embeds `engine_id`, `model` and native `reasoning`. No profile registry or separate effort ladder.
- `manual_override`: optional, null for automatic routing; otherwise either `{"route":"ordinary"}` (any declared route) or a complete `engine_id` / `model` / `reasoning` profile. These forms are mutually exclusive. The override takes precedence over every task's complexity, including owner assessments, without changing the assessment itself.
- Reasoning is `{ "mode": "effort", "value": "native-value" }` or `{ "mode": "engine_default" }`. Display labels are not native values. No cross-engine normalization.
- `limits.max_parallel` bounds activity units, including the caller and unrelated active/blocked/unknown Agents. It is not a process count or provider quota.

The shipped example routes ordinary work to Qoder `Qwen3.8-Flash / xhigh` (Extra High), moderate work to Codex `gpt-6-astra / medium`, and complex work to Codex `gpt-6-astra / high`. These are explicit configuration values, not an implicit fallback.

For quota pressure, set this top-level field in the selected config to force all dispatched tasks through the existing ordinary profile:

```json
"manual_override": { "route": "ordinary" }
```

Or specify a complete execution profile independently of the difficulty routes (engine IDs must exist in `engines`):

```json
"manual_override": {
  "engine_id": "example-qoder",
  "model": "Qwen3.8-Flash",
  "reasoning": { "mode": "effort", "value": "xhigh" }
}
```

Set `manual_override` to null or remove it to restore automatic routing. The shipped example leaves it null; adding this feature does not enable a user-wide override. Apply the same effective profile to direct delegation. Probes and capacity use the effective execution profile. Jev A/B still run where required: manual routing does not bypass owner-required/need-context outcomes, confidence policy, dependencies, ownership, capability or resource guards. It does not switch the caller's current session or Jev's decision model. A config change invalidates an unreserved decision; decide again before dispatch. Already reserved attempts retain their frozen bindings.

`agent-engines.ts` separately validates native syntax and probes exact runtime contracts. Probe is read-only: CLI version, Qoder model listing, and Codex's active `CODEX_HOME/models_cache.json` (24h freshness and matching CLI version). `supported` requires a specifically accepted CLI-version/model/effort combination. New versions, untested combinations and `engine_default` stay `unknown`. Unsupported syntax is rejected before execution. A valid config or model name alone is not support.

Evidence is **launch_only** compatibility. Codex cache is not real-time account authorization; Qoder's accepted xhigh flag and local Extra High mapping do not establish effort readback. Each field's readback remains null unless separately observed. Probe does not guarantee account quota, cwd tools or task-specific capabilities. V1 blocks nonempty task capability requirements until the owner resolves them in decomposition; it does not invent a generic tool-capability registry.

## Task facts and Jev questions

Start from [`examples/jev-batch.json`](../examples/jev-batch.json). Supply real absolute cwd values and canonical resource keys shared by every participant. Prefixes overlap: `repo/app/src` conflicts with `repo/app/src/a.ts`; globs and `..` are rejected. Filesystem isolation does not isolate databases or services. Use `cow-workspace` when independent writes need isolated filesystems.

A task has a stable ID and revision, inputs/evidence, deliverable, acceptance criteria, dependencies, known read/write ownership (or explicit unknown), uncertainties, requirements, delegated/reserved decisions and execution context. Increase revision when its definition changes. Missing root cause within an authorized investigation is not missing pre-dispatch context. A dependency requires an accepted revision, delivered artifacts and owner evidence; a worker being idle or saying done is insufficient.

Every active external Agent needs an explicit entry in `external_resources` whose `id` is its Herdr pane ID and whose reads/writes describe the actual scope, including the main Agent. Empty arrays mean positively known empty access, not uninspected access. Uncovered active Agents block dispatch. Update this snapshot from actual ownership handoffs; the script cannot discover undeclared semantic or external-service conflicts.

Jev A classifies eligible tasks independently: first `owner_required` when a necessary decision exceeds delegation, then `need_context` for unavailable pre-dispatch facts, then `complex / moderate / ordinary`. No engine names or capacity affect difficulty. Matching assessments are reused; owner assessments require evidence. Raw Jev answers are retained and re-adopted under the current 0.8 confidence policy. This threshold is a conservative local policy, not a quality guarantee.

Local code maps difficulty through config and checks dependencies, same-task revisions, resource conflicts, engine/global capacity and exact capability probes. It constructs at most 12 deterministic greedy/singleton waves, not a Cartesian product. Tasks omitted by the bound remain for a later decision. Jev B chooses one frozen candidate or `need_context / owner_required`; even a single candidate retains semantic exit choices. If grouping is already explicitly settled by the owner, an optional batch `owner_wave: {"task_ids":["date","money"],"evidence":"specific semantic-independence verification"}` skips B only when it exactly matches a locally valid offered wave. It cannot change profiles or bypass guards; an invalid group returns owner-required. This is recorded owner evidence, never an automatic API-failure fallback. A and B are separate requests: answers within one request never depend on each other.

Requests use `https://openrouter.ai/api/alpha/decisions`, `~typesafe/jev-latest`, and `OPENROUTER_API_KEY` from the caller environment. Full requests are limited to 24,000 UTF-8 bytes, responses to 64,000 bytes, with no truncation, automatic retries or model substitution. Missing confidence is owner-required; confidence/probabilities are optional protocol fields and validated when present. HTTP errors omit provider bodies and credentials.

## Decide and dispatch

```sh
bun scripts/decide-tasks.ts --input /private/batch.json --config /private/agents.json --dry-run
bun scripts/decide-tasks.ts --input /private/batch.json --config /private/agents.json --state /private/task/scheduling.json
bun scripts/dispatch-tasks.ts --action dispatch --input /private/batch.json --config /private/agents.json --state /private/task/scheduling.json --decision DECISION_ID --caller-pane PANE_ID --label '0923｜FEA｜具体任务'
```

Dry-run validates config and shows classification inputs; it performs no probes, API calls, writes or side effects and does not imply dispatchability. Live decide persists exact requests, responses, assessments, candidates, runtime facts and frozen bindings. Only `status=selected` is dispatchable.

Keep one durable state path for this batch and all its controllers. Do not create a second state file to bypass reservations or to retry unknown effects. Writes use an exclusive local lock, atomic replacement and fsync. A lock is never stolen automatically; after a crash, inspect its PID and prove the writer has exited before manually removing only that lock. State is private (0600), contains task context, and must not be committed or copied to public artifacts. New decisions stop at 12 MB; atomic writes reject over 16 MB while retaining the previous readable state, reserving headroom for recovery. Keep batches bounded; retain completed records when moving to a separate new batch.

Dispatch reloads input/config, probes and inventories under the lock, then atomically reserves the whole wave. This reservation is the commit point; later config edits do not change in-flight bindings. Task cancellation or changed authorization stops subsequent effects. The sequence is `create_lane → start_agent → submit`: persist intent before each effect and confirmation after it. Canonical `herdr --kind` plus an argv array prevents configurable executable injection. Returned IDs and exact cleanup commands are recorded. V1 creates owned independent lanes; it does not transfer native sessions or claim borrowed lanes as owned.

A timeout or unreadable reply is `unknown`, not failure-to-execute. The attempt retains its slot and writes. Neither restarting the CLI nor selecting a new task revision replays the effect. Observe the known pane; if the creation reply was lost and the handle is unknown, return to the owner for inventory/evidence. V1 does not automatically resume a partially started attempt; the owner reconciles and stops it before a fresh decision. Local UUIDs are correlation only, not remote idempotency keys.

## Observe, accept and release

```sh
bun scripts/dispatch-tasks.ts --action observe --state /private/task/scheduling.json
bun scripts/dispatch-tasks.ts --action accept --state /private/task/scheduling.json --attempt ATTEMPT_ID --evidence /private/acceptance.json
bun scripts/dispatch-tasks.ts --action cleanup --state /private/task/scheduling.json --attempt ATTEMPT_ID --caller-pane MAIN_PANE
```

Workers receive a unique result file path in `STATE.results/ATTEMPT.json` and the exact result schema in their prompt. Observe requires the same known native session, idle/done state and matching attempt/task/revision result. No native session identity means owner reconciliation. A completed or failed worker releases its activity slot but retains write ownership until accepted or explicitly resolved. Result paths are bounded regular JSON files; symlinks and mismatches are rejected.

Acceptance JSON:

```json
{"task_revision":1,"attempt_id":"ATTEMPT_ID","artifact_refs":["delivered/path"],"delivery_evidence_ref":"verification-log-or-commit","owner_evidence_ref":"owner-review-record"}
```

Owner verification must cover actual artifacts and task criteria; the script checks bindings, not artifact truth. Acceptance is overlaid onto the next batch read, unlocking dependencies only for the exact delivered revision. Whole-goal completion also requires `goal_accepted=true` and every task accepted. Cancelled tasks are not success.

For an uncertain or failed attempt, first inspect the actual pane/session, stop any live work, and account for partial writes. Then use:

```sh
bun scripts/dispatch-tasks.ts --action resolve --state /private/task/scheduling.json --attempt ATTEMPT_ID --outcome failed_stopped --evidence /private/resolution.json
```

Proof is `{"evidence":"specific owner observation and write-disposition record"}`. Outcomes are `not_performed`, `failed_stopped`, or `cancelled_stopped`. This is an explicit owner assertion, not autonomous proof. It releases reservations without retrying or undoing filesystem/data changes. A new decision is necessary to retry.

Cleanup only closes a resolved, owned idle lane with matching session identity, current pane/container membership and actual caller identity; additional panes/tabs are rejected and removal is read back. Cleanup intent/outcome is recorded; unknown cleanup is inspected, not retried blindly. The caller pane, borrowed resources, working directories, results, state, configuration and persistent data are never deleted by these commands. Release task-owned processes separately from retaining data and evidence.

## Practical limits

- Reservations are atomic within the shared state file. Herdr has no global admission-control transaction: independently managed schedulers/state files can race after inventory. Use one main dispatcher per ownership/capacity scope; external starts still require coordination.
- Probes and inventory are snapshots. Session startup can still fail or time out; this does not justify a fallback or another start.
- Resource declarations and acceptance are owner evidence, not filesystem or authorization enforcement. Agents may execute tools within their own configured permissions.
- Unknown intent requires human/main-Agent reconciliation. No exactly-once remote execution, cross-engine session restoration or automated retry is claimed.

The reviewed design and rationale are in [heterogeneous-agent-design.md](heterogeneous-agent-design.md).
