import { createHash } from "node:crypto";

import { canonicalJson as stableJson, isRecord, type RuntimeRecord, ValueError } from "./runtime_types.ts";

export const MODE_KINDS = new Set(["swarm", "develop_review_improve", "multi_session_review"]);
export const MODE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "develop-review-improve": "develop_review_improve",
  "multi-session-review": "multi_session_review",
});
export const MODE_TERMINAL = new Set(["completed", "blocked", "failed", "cancelled"]);
export const FINDING_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
export const VERIFICATION_VERDICTS = new Set(["confirmed", "rejected", "unresolved"]);
export const MAX_EVIDENCE_BYTES = 12_000;
export const RESERVED_EVIDENCE_PREVIEW_BYTES = 1_024;
export const LOOP_PHASES = ["develop", "validate", "review", "verify", "improve", "revalidate", "re_review"] as const;
export const LOOP_EXIT_CONDITIONS = Object.freeze({
  passed: "clean_review",
  validation_failure: "blocked",
  high_severity_unresolved: "blocked",
  max_rounds: "budget_exhausted",
  no_progress: "no_progress",
});
export const COMMON_CONFIG_FIELDS = new Set([
  "max_rounds",
  "max_tasks",
  "max_candidates",
  "max_expansions",
  "max_seconds",
  "max_mode_depth",
  "max_no_progress",
  "create_fix_tasks",
]);

export const START_MODE_SCHEMA = {
  title: "start_mode",
  type: "object",
  required: ["mode", "objective"],
  properties: {
    mode: { enum: [...MODE_KINDS, ...Object.keys(MODE_ALIASES)].sort() },
    objective: { type: "string" },
    parent_mode_id: { type: ["integer", "null"] },
    tasks: { type: "array" },
    config: {
      type: "object",
      properties: {
        reviewers: {
          type: "array",
          minItems: 3,
          items: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string", minLength: 1 },
              profile_hint: { type: ["string", "null"], minLength: 1 },
            },
          },
        },
        phases: { type: "array", items: { enum: [...LOOP_PHASES] } },
        exit_conditions: { type: "object" },
      },
    },
    evidence: {},
  },
};

export const ADVANCE_MODE_SCHEMA = {
  title: "advance_mode",
  type: "object",
  required: ["mode_id"],
  properties: {
    mode_id: { type: "integer" },
    operation: { enum: ["advance", "cancel"] },
    reason: { type: "string" },
  },
};

export function canonicalJson(value: unknown): string {
  return stableJson(value);
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function text(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

function utf8Prefix(encoded: Buffer, limit: number): string {
  let end = Math.max(0, Math.min(Math.trunc(limit), encoded.byteLength));
  while (end >= 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function sectionedContent(value: RuntimeRecord, limit: number, reservedKeys: readonly string[]): string {
  const encodedSections = Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, Buffer.from(canonicalJson(value[key]), "utf8")]),
  ) as Record<string, Buffer>;
  const sections: Record<string, RuntimeRecord> = Object.fromEntries(
    Object.entries(encodedSections).map(([key, encoded]) => [
      key,
      {
        sha256: createHash("sha256").update(encoded).digest("hex"),
        bytes: encoded.byteLength,
        truncated: true,
        content: "",
      },
    ]),
  );
  const envelope = { format: "sectioned-canonical-json-v1", sections };
  const render = () => Buffer.from(canonicalJson(envelope), "utf8");
  if (render().byteLength > limit) throw new ValueError("evidence limit is too small for reserved section metadata");

  const grow = (key: string, maximum: number): void => {
    const encoded = encodedSections[key]!;
    let low = Buffer.byteLength(String(sections[key]!.content), "utf8");
    let high = Math.min(maximum, encoded.byteLength);
    let best = low;
    while (low <= high) {
      const requested = Math.floor((low + high) / 2);
      const preview = utf8Prefix(encoded, requested);
      sections[key]!.content = preview;
      sections[key]!.truncated = Buffer.byteLength(preview, "utf8") < encoded.byteLength;
      if (render().byteLength <= limit) {
        best = requested;
        low = requested + 1;
      } else {
        high = requested - 1;
      }
    }
    const preview = utf8Prefix(encoded, best);
    sections[key]!.content = preview;
    sections[key]!.truncated = Buffer.byteLength(preview, "utf8") < encoded.byteLength;
  };

  const presentReserved = reservedKeys.filter((key) => key in encodedSections);
  for (const key of presentReserved) grow(key, RESERVED_EVIDENCE_PREVIEW_BYTES);
  for (const key of Object.keys(encodedSections).filter((key) => !presentReserved.includes(key)).sort()) {
    grow(key, encodedSections[key]!.byteLength);
  }
  for (const key of presentReserved) grow(key, encodedSections[key]!.byteLength);
  return render().toString("utf8");
}

export interface EvidenceBundle extends RuntimeRecord {
  sha256: string;
  bytes: number;
  truncated: boolean;
  content: string;
}

export function boundedBundle(
  value: unknown,
  limit = MAX_EVIDENCE_BYTES,
  reservedKeys: readonly string[] = [],
): EvidenceBundle {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new ValueError("evidence limit must be a non-negative integer");
  const encoded = Buffer.from(canonicalJson(value), "utf8");
  const content = encoded.byteLength > limit && reservedKeys.length > 0 && isRecord(value)
    ? sectionedContent(value, limit, reservedKeys)
    : utf8Prefix(encoded, limit);
  return {
    sha256: createHash("sha256").update(encoded).digest("hex"),
    bytes: encoded.byteLength,
    truncated: encoded.byteLength > limit,
    content,
  };
}

export function findingFingerprint(finding: RuntimeRecord): string {
  return `finding_${digest({
    rule: text(finding.rule),
    title: text(finding.title),
    description: text(finding.description),
    location: text(finding.location),
  }).slice(0, 24)}`;
}

export function validateFinding(
  value: unknown,
  label = "finding",
  requireStandard = false,
): RuntimeRecord {
  if (!isRecord(value)) throw new ValueError(`${label} must be an object`);
  const { title, description, severity, evidence, claim, impact, confidence } = value;
  if (typeof title !== "string" || !title.trim()) throw new ValueError(`${label}.title is required`);
  if (typeof description !== "string" || !description.trim()) throw new ValueError(`${label}.description is required`);
  if (typeof severity !== "string" || !FINDING_SEVERITIES.has(severity)) {
    throw new ValueError(`${label}.severity must be low, medium, high, or critical`);
  }
  if (
    !Array.isArray(evidence) || evidence.length === 0 ||
    !evidence.every((item) => typeof item === "string" || isRecord(item))
  ) throw new ValueError(`${label}.evidence must be a non-empty array`);
  if (requireStandard) {
    if (typeof claim !== "string" || !claim.trim()) throw new ValueError(`${label}.claim is required`);
    if (typeof impact !== "string" || !impact.trim()) throw new ValueError(`${label}.impact is required`);
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new ValueError(`${label}.confidence must be a number in 0..1`);
    }
  } else if (
    confidence !== null && confidence !== undefined &&
    (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
  ) throw new ValueError(`${label}.confidence must be a number in 0..1`);
  const normalized: RuntimeRecord = {
    rule: String(value.rule ?? "").trim(),
    title: title.trim(),
    description: description.trim(),
    location: String(value.location ?? "").trim(),
    severity,
    evidence,
    claim: typeof claim === "string" && claim.trim() ? claim.trim() : title.trim(),
    impact: typeof impact === "string" && impact.trim() ? impact.trim() : description.trim(),
    confidence: confidence === null || confidence === undefined ? null : confidence,
  };
  normalized.fingerprint = findingFingerprint(normalized);
  return normalized;
}

function integer(config: RuntimeRecord, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = config[name] ?? fallback;
  if (!Number.isSafeInteger(value) || typeof value === "boolean" || value < minimum || value > maximum) {
    throw new ValueError(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

export function normalizeConfig(kind: string, supplied: unknown): RuntimeRecord {
  const source = supplied ?? {};
  if (!isRecord(source)) throw new ValueError("start_mode config must be an object");
  const allowed = new Set(COMMON_CONFIG_FIELDS);
  if (kind === "multi_session_review") allowed.add("reviewers");
  if (kind === "develop_review_improve") {
    allowed.add("phases");
    allowed.add("exit_conditions");
  }
  const unknown = Object.keys(source).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new ValueError(`unsupported ${kind} config fields: ${unknown.join(", ")}`);
  const config: RuntimeRecord = Object.fromEntries(
    Object.entries(source).filter(([key]) => COMMON_CONFIG_FIELDS.has(key)),
  );
  config.max_rounds = integer(config, "max_rounds", 3, 1, 20);
  config.max_tasks = integer(config, "max_tasks", 50, 1, 500);
  config.max_candidates = integer(config, "max_candidates", 50, 1, 200);
  config.max_expansions = integer(config, "max_expansions", 10, 0, 100);
  config.max_seconds = integer(config, "max_seconds", 3_600, 1, 86_400);
  config.max_mode_depth = integer(config, "max_mode_depth", 4, 0, 8);
  config.max_no_progress = integer(config, "max_no_progress", 2, 1, 5);
  config.create_fix_tasks = config.create_fix_tasks ?? true;
  if (typeof config.create_fix_tasks !== "boolean") throw new ValueError("create_fix_tasks must be boolean");
  if (kind === "develop_review_improve") {
    const phases = source.phases ?? LOOP_PHASES;
    if (canonicalJson(phases) !== canonicalJson(LOOP_PHASES)) {
      throw new ValueError(`develop_review_improve phases must declare the canonical v1 phase order: ${LOOP_PHASES.join(", ")}`);
    }
    const exitConditions = source.exit_conditions ?? LOOP_EXIT_CONDITIONS;
    if (canonicalJson(exitConditions) !== canonicalJson(LOOP_EXIT_CONDITIONS)) {
      throw new ValueError("develop_review_improve exit_conditions must declare the canonical v1 contract");
    }
    config.phases = [...LOOP_PHASES];
    config.exit_conditions = { ...LOOP_EXIT_CONDITIONS };
  }
  if (kind === "multi_session_review") {
    const reviewers = source.reviewers ?? Array.from({ length: 3 }, (_, index) => ({
      id: `reviewer-${index + 1}`,
      profile_hint: null,
    }));
    if (!Array.isArray(reviewers) || reviewers.length < 3) {
      throw new ValueError("multi_session_review requires at least 3 reviewers");
    }
    const identifiers = new Set<string>();
    config.reviewers = reviewers.map((reviewer) => {
      if (!isRecord(reviewer)) throw new ValueError("reviewers must be objects");
      const identifier = reviewer.id;
      if (typeof identifier !== "string" || !identifier.trim()) throw new ValueError("reviewer.id is required");
      const normalizedIdentifier = identifier.trim();
      if (identifiers.has(normalizedIdentifier)) throw new ValueError("reviewer ids must be independent and unique");
      identifiers.add(normalizedIdentifier);
      const profileHint = reviewer.profile_hint;
      if (profileHint !== null && profileHint !== undefined && (typeof profileHint !== "string" || !profileHint.trim())) {
        throw new ValueError("reviewer.profile_hint must be a non-empty profile name");
      }
      return {
        id: normalizedIdentifier,
        profile_hint: typeof profileHint === "string" ? profileHint.trim() : null,
      };
    });
  }
  return config;
}

export function validateStartPayload(payload: unknown): RuntimeRecord {
  if (!isRecord(payload)) throw new ValueError("start_mode payload must be an object");
  const rawKind = payload.mode;
  const kind = typeof rawKind === "string" ? (MODE_ALIASES[rawKind] ?? rawKind) : rawKind;
  if (typeof kind !== "string" || !MODE_KINDS.has(kind)) throw new ValueError("start_mode mode is unsupported");
  if (typeof payload.objective !== "string" || !payload.objective.trim()) {
    throw new ValueError("start_mode objective is required");
  }
  const parentModeId = payload.parent_mode_id;
  if (parentModeId !== null && parentModeId !== undefined && (!Number.isSafeInteger(parentModeId) || typeof parentModeId === "boolean")) {
    throw new ValueError("parent_mode_id must be an integer or null");
  }
  if (kind === "swarm" && (!Array.isArray(payload.tasks) || payload.tasks.length === 0)) {
    throw new ValueError("swarm mode requires a non-empty tasks array");
  }
  return {
    kind,
    objective: payload.objective.trim(),
    parent_mode_id: parentModeId ?? null,
    tasks: payload.tasks,
    config: normalizeConfig(kind, payload.config),
    evidence_bundle: boundedBundle(payload.evidence ?? {}),
  };
}

function findings(result: RuntimeRecord): RuntimeRecord[] {
  const values = result.findings ?? [];
  if (!Array.isArray(values)) throw new ValueError("mode_result.findings must be an array");
  return values.map((value, index) => validateFinding(value, `mode_result.findings[${index}]`, true));
}

function evidence(result: RuntimeRecord, role: string): unknown[] {
  if (!Array.isArray(result.evidence) || result.evidence.length === 0) {
    throw new ValueError(`${role} mode_result.evidence must be a non-empty array`);
  }
  return result.evidence;
}

export function validateModeResult(link: RuntimeRecord, mode: RuntimeRecord, result: unknown): RuntimeRecord {
  if (!isRecord(result)) throw new ValueError("done mode task requires mode_result object");
  const role = link.role;
  const normalized: RuntimeRecord = { ...result };
  if (role === "swarm") {
    if (!new Set(["done", "partial"]).has(result.status as string)) {
      throw new ValueError("swarm mode_result.status must be done or partial");
    }
    evidence(result, role);
  } else if (role === "developer") {
    if (typeof result.summary !== "string" || !result.summary.trim()) {
      throw new ValueError("developer mode_result.summary is required");
    }
    evidence(result, role);
  } else if (role === "validator") {
    const expectedStage = link.phase === "revalidate" ? "revalidation" : "validation";
    if (result.stage !== expectedStage) throw new ValueError(`validator mode_result.stage must be ${expectedStage}`);
    if (!new Set(["passed", "failed", "blocked"]).has(result.status as string)) {
      throw new ValueError("validator mode_result.status must be passed, failed, or blocked");
    }
    if (!Array.isArray(result.commands) || result.commands.length === 0 || !result.commands.every(
      (item) => typeof item === "string" && item.trim().length > 0,
    )) throw new ValueError("validator mode_result.commands must be a non-empty string array");
    if (typeof result.artifact_version !== "string" || !result.artifact_version.trim()) {
      throw new ValueError("validator mode_result.artifact_version is required");
    }
    evidence(result, role);
  } else if (role === "reviewer") {
    normalized.findings = findings(result);
    if (mode.kind === "develop_review_improve") {
      if (!new Set(["pass", "changes_requested", "blocked"]).has(result.verdict as string)) {
        throw new ValueError("loop reviewer mode_result.verdict is invalid");
      }
      if (result.verdict === "changes_requested" && (normalized.findings as unknown[]).length === 0) {
        throw new ValueError("changes_requested requires at least one finding");
      }
    }
  } else if (role === "verifier_reproduce" || role === "verifier_falsify") {
    if (result.candidate_fingerprint !== link.candidate_fingerprint) {
      throw new ValueError("verifier candidate_fingerprint does not match assigned candidate");
    }
    if (typeof result.verdict !== "string" || !VERIFICATION_VERDICTS.has(result.verdict)) {
      throw new ValueError("verifier mode_result.verdict is invalid");
    }
    if (!Array.isArray(result.evidence) || result.evidence.length === 0) {
      throw new ValueError("verifier mode_result.evidence must be a non-empty array");
    }
    const discovered = result.discovered_findings ?? [];
    if (!Array.isArray(discovered)) throw new ValueError("verifier discovered_findings must be an array");
    normalized.discovered_findings = discovered.map((value, index) =>
      validateFinding(value, `mode_result.discovered_findings[${index}]`, true));
  } else if (role === "improver") {
    if (typeof result.changed !== "boolean") throw new ValueError("improver mode_result.changed must be boolean");
    if (!Array.isArray(result.addressed_fingerprints ?? [])) {
      throw new ValueError("improver addressed_fingerprints must be an array");
    }
    evidence(result, role);
  } else if (role === "fixer") {
    if (!Array.isArray(result.fixed_fingerprints) || !result.fixed_fingerprints.includes(link.candidate_fingerprint)) {
      throw new ValueError("fixer must report its assigned confirmed fingerprint");
    }
    if (!Array.isArray(result.evidence) || result.evidence.length === 0) {
      throw new ValueError("fixer mode_result.evidence must be a non-empty array");
    }
  } else {
    throw new ValueError(`unsupported mode task role: ${role}`);
  }
  delete normalized.runtime_result_fingerprint;
  normalized.runtime_result_fingerprint = digest(normalized);
  return normalized;
}
