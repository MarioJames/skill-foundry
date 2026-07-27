import { isRecord, type RuntimeRecord, ValueError } from "./runtime_types.ts";

export const TIERS = new Set(["strong", "balanced", "fast"]);

function jsonObject(raw: unknown, label: string): RuntimeRecord {
  if (typeof raw !== "string") throw new ValueError(`${label} is invalid`);
  try {
    const value: unknown = JSON.parse(raw || "{}");
    if (!isRecord(value)) throw new Error();
    return value;
  } catch {
    throw new ValueError(`${label} is invalid`);
  }
}

export function selectModelTier(task: RuntimeRecord): string {
  if (typeof task.model_tier_hint === "string" && TIERS.has(task.model_tier_hint)) return task.model_tier_hint;
  const complexity = task.complexity_hint || "medium";
  if (task.intent_hint === "design" || complexity === "high") return "strong";
  if (new Set(["review", "integrate"]).has(task.intent_hint) || complexity === "medium") return "balanced";
  return "fast";
}

export function profileHint(task: RuntimeRecord): string | null {
  const direct = task.profile_hint;
  const constraints = jsonObject(task.constraints_json || "{}", "task constraints_json");
  const nested = constraints.profile_hint;
  if (direct !== null && direct !== undefined && nested !== null && nested !== undefined && direct !== nested) {
    throw new ValueError("conflicting child profile_hint values");
  }
  const hint = direct ?? nested;
  if (hint !== null && hint !== undefined && (typeof hint !== "string" || !hint)) {
    throw new ValueError("child profile_hint must be a non-empty string");
  }
  return (hint as string | null | undefined) ?? null;
}

export function profileAllowlist(run: RuntimeRecord): string[] {
  const execution = jsonObject(run.execution_config_json || "{}", "run execution_config_json");
  const allowlist = execution.profile_allowlist;
  const profiles = execution.profiles;
  if (Array.isArray(allowlist) && allowlist.length > 0 && isRecord(profiles)) {
    if (!allowlist.every((name): name is string => typeof name === "string" && name in profiles)) {
      throw new ValueError("run profile allowlist is invalid");
    }
    return [...allowlist];
  }
  if (execution.backend === "acp") {
    return [isRecord(execution.acp) && typeof execution.acp.agent === "string" ? execution.acp.agent : "claude"];
  }
  return ["claude_cli"];
}

export function selectProfile(run: RuntimeRecord, task: RuntimeRecord, routingIndex = 0): string {
  const allowlist = profileAllowlist(run);
  const hint = profileHint(task);
  if (hint !== null) {
    if (!allowlist.includes(hint)) throw new ValueError("child profile_hint is not present in the Run profile allowlist");
    return hint;
  }
  if (allowlist.length === 1) return allowlist[0]!;
  if (!Number.isSafeInteger(routingIndex)) throw new ValueError("profile routing index must be an integer");
  const execution = jsonObject(run.execution_config_json || "{}", "run execution_config_json");
  const defaultProfile = execution.default_profile;
  if (typeof defaultProfile !== "string" || !allowlist.includes(defaultProfile)) {
    throw new ValueError("run default profile is not allowlisted");
  }
  const start = allowlist.indexOf(defaultProfile);
  return allowlist[(start + routingIndex) % allowlist.length]!;
}

export function resolveModel(run: RuntimeRecord, tier: string, profileName?: string): string {
  if (profileName !== undefined) {
    const execution = jsonObject(run.execution_config_json || "{}", "run execution_config_json");
    const profiles = execution.profiles;
    const profile = isRecord(profiles) ? profiles[profileName] : undefined;
    if (isRecord(profile) && isRecord(profile.model_tiers) && typeof profile.model_tiers[tier] === "string") {
      return profile.model_tiers[tier] as string;
    }
  }
  const mapping = jsonObject(run.model_tiers_json || "{}", "run model_tiers_json");
  return typeof mapping[tier] === "string" ? mapping[tier] as string : tier;
}
