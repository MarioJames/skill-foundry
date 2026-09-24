import { executionProfile, probeProfile, type RoutingConfig } from "./agent-engines";
import { applyAcceptances, type State } from "./dispatch-state";
import { validateBatch, identifier, strings, textValue, type Batch, type Runtime } from "./scheduling";
import { CliError } from "./cli";
import { rpcCatalog, rpcProbe } from "./rpc-catalog";

/** Small public handoff, expanded into the existing admission contract. */
export function taskBatch(input: any, state: State, config: RoutingConfig): { batch: Batch; agents: Runtime["agents"] } {
  identifier(input.scope_id, "scope_id"); identifier(input.id, "id");
  if (input.parallel_evidence !== undefined) throw new CliError("jev_required", "run-task delegates parallel selection to Jev; parallel_evidence cannot bypass it");
  if (!input.owner || !["codex", "qodercli", "other"].includes(input.owner.adapter))
    throw new CliError("owner_required", "Declare the parent adapter and its current read/write ownership");
  if (state.attempts.some((a) => a.task.id === input.id && a.task.revision === input.revision))
    throw new CliError("attempt_exists", "This task revision already has an attempt; observe it instead of replaying. Deliberate retries require a new revision after resolution.");
  const external = [input.owner, ...(input.external_agents ?? [])];
  const agents: Runtime["agents"] = external.map((x: any) => {
    textValue(x.id, "external id"); strings(x.reads, "external reads"); strings(x.writes, "external writes");
    if (!["codex", "qodercli", "other"].includes(x.adapter)) throw new CliError("invalid_adapter", "External adapter must be declared");
    return { pane_id: x.id, adapter: x.adapter === "other" ? undefined : x.adapter, engine_id: Object.keys(config.engines).find((k) => config.engines[k].adapter === x.adapter) ?? null, state: "working", ...(x.session_id ? { session_id: x.session_id } : {}) };
  });
  if (new Set(agents.map((x) => x.pane_id)).size !== agents.length) throw new CliError("duplicate_external", "External identities must be unique");
  const depends = input.depends_on ?? [];
  strings(depends, "depends_on");
  const upstream = depends.map((id: string) => {
    const attempts = state.attempts.filter((a) => a.task.id === id);
    const latest = attempts.sort((a, b) => b.task.revision - a.task.revision)[0];
    if (!latest?.acceptance || attempts.some((a) => a.slot === "held" || a.writes_held)) throw new CliError("dependency_not_accepted", `Dependency ${id} must have an accepted current revision`);
    return { ...latest.binding.task, status: "accepted", acceptance_record: latest.acceptance };
  });
  const task = {
    id: input.id, revision: input.revision, status: "pending", summary: textValue(input.prompt, "prompt"),
    inputs: [], deliverable: input.deliverable, acceptance: input.acceptance,
    depends_on: depends, resources: { status: "known", ...input.resources }, uncertainties: [],
    requirements: { capabilities: [], owner_only: false },
    decision_boundary: { delegated: [input.prompt], reserved_for_owner: ["integration, Git commits, shared configuration, approval, acceptance"], authorization_refs: [textValue(input.authorization, "authorization")] },
    execution: { cwd: input.cwd, workspace_ref: input.cwd },
    ...(input.complexity ? { owner_assessment: { complexity: input.complexity, evidence: textValue(input.assessment_evidence, "assessment_evidence") } } : {}),
  };
  const batch = applyAcceptances(validateBatch({ version: 1, id: input.scope_id, goal: input.goal ?? input.prompt,
    constraints: input.constraints ?? [], goal_accepted: false, tasks: [...upstream, task],
    external_resources: external.map((x: any) => ({ id: x.id, reads: x.reads, writes: x.writes })),
  }), state);
  return { batch, agents };
}

export async function taskRuntime(config: RoutingConfig, agents: Runtime["agents"], mode = "oneshot"): Promise<Runtime> {
  const probes: any = {};
  const profiles = new Map<string, Awaited<ReturnType<typeof probeProfile>>>();
  let catalog: Awaited<ReturnType<typeof rpcCatalog>> | undefined;
  for (const complexity of ["ordinary", "moderate", "complex"] as const) {
    const profile = executionProfile(config, complexity), key = JSON.stringify(profile);
    if (!profiles.has(key)) {
      if (config.engines[profile.engine_id].adapter === "codex") {
        catalog ??= await rpcCatalog(); profiles.set(key, rpcProbe(config, profile, catalog));
      } else profiles.set(key, await probeProfile(config, profile));
    }
    probes[complexity] = profiles.get(key);
  }
  return { observed_at: new Date().toISOString(), agents, probes };
}
