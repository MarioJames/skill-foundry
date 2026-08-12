#!/usr/bin/env bun

import type { JsonObject } from "./core.ts";

export function relationShapeErrors(relations: any): string[] {
  if (!Array.isArray(relations)) {
    return ["`relations` 必须是数组。"];
  }
  const errors: string[] = [];
  relations.forEach((relation, index) => {
    if (relation === null || typeof relation !== "object" || Array.isArray(relation)) {
      errors.push(`relations[${index}] 必须是对象。`);
      return;
    }
    for (const key of ["from", "to", "type"]) {
      const value = relation[key];
      if (typeof value !== "string" || !value) {
        errors.push(`relations[${index}] 缺少非空字符串字段 \`${key}\`。`);
      }
    }
  });
  return errors;
}

export function normalizeStandaloneRepos(items: any): JsonObject[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const normalized: JsonObject[] = [];
  for (const item of items) {
    if (typeof item === "string" && item) {
      normalized.push({
        repo: item,
        summary: "",
        reason: "",
        evidence: [],
      });
      continue;
    }
    if (item === null || typeof item !== "object" || Array.isArray(item) || !item.repo) {
      continue;
    }
    normalized.push({
      repo: item.repo,
      summary: item.summary ?? "",
      reason: item.reason ?? "",
      evidence: item.evidence ?? [],
    });
  }
  return normalized;
}

export function mergeEvidence(...groups: Array<string[] | undefined | null>): string[] {
  const kept = new Map<string, string>();
  for (const group of groups) {
    for (const item of group ?? []) {
      const key = item.replace(/\/+$/, "") || item;
      if (!kept.has(key)) {
        kept.set(key, item);
      }
    }
  }
  return [...kept.values()].sort();
}

export function mentionDetails(mention: any): [number, string[]] {
  if (mention !== null && typeof mention === "object" && !Array.isArray(mention)) {
    return [mention.count ?? 0, mention.files ?? []];
  }
  return [mention, ["pom.xml"]];
}

export function autoRelations(discovery: JsonObject): JsonObject[] {
  const repoNames = new Set<string>((discovery.repos ?? []).map((repo: JsonObject) => repo.name));
  const relations: JsonObject[] = [];
  for (const repo of discovery.repos ?? []) {
    const source = repo.name;
    const manifests = new Set<string>(repo.manifests ?? []);
    for (const target of repo.frontend?.service_targets ?? []) {
      if (!repoNames.has(target)) {
        continue;
      }
      const evidence: string[] = [];
      if (manifests.has("config/config.ts")) {
        evidence.push(`${source}/config/config.ts`);
      }
      evidence.push(`${source}/src/services/${target}`);
      relations.push({
        from: source,
        to: target,
        type: "consumes_api",
        direction: "directed",
        summary: `${source} 通过生成的 service client 直接消费 ${target}。`,
        evidence,
        source: "detected",
      });
    }
    const mentions = Object.entries(repo.sibling_mentions ?? {}).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const [target, mention] of mentions) {
      if (!repoNames.has(target) || repo.detected_kind !== "maven-service") {
        continue;
      }
      const [count, files] = mentionDetails(mention);
      relations.push({
        from: source,
        to: target,
        type: "depends_on_repo_artifacts",
        direction: "directed",
        summary: `${target} 出现在 ${source} 的 Maven 配置或入口声明中，构成仓库级依赖证据。`,
        evidence: [
          ...files.map((item) => `${source}/${item}`),
          `mention_count=${count}`,
        ],
        source: "detected",
      });
    }
  }
  const deduped = new Map<string, JsonObject>();
  for (const relation of relations) {
    const key = JSON.stringify([relation.from, relation.to, relation.type]);
    if (!deduped.has(key)) {
      deduped.set(key, relation);
      continue;
    }
    const existing = deduped.get(key)!;
    existing.evidence = mergeEvidence(existing.evidence ?? [], relation.evidence ?? []);
  }
  return [...deduped.values()];
}

export function mergeRelations(
  declared: JsonObject[],
  detected: JsonObject[],
): JsonObject[] {
  const merged = new Map<string, JsonObject>();
  for (const relation of [...declared, ...detected]) {
    const key = JSON.stringify([relation.from, relation.to, relation.type]);
    if (!merged.has(key)) {
      merged.set(key, { ...relation });
      continue;
    }
    const current = merged.get(key)!;
    current.direction = current.direction || relation.direction || "directed";
    current.summary = current.summary || relation.summary || "";
    current.evidence = mergeEvidence(current.evidence ?? [], relation.evidence ?? []);
    const sources = new Set([
      current.source ?? "declared",
      relation.source ?? "detected",
    ]);
    current.source = [...sources].sort().join("+");
  }
  for (const relation of merged.values()) {
    relation.direction ??= "directed";
    relation.source ??= "declared";
    relation.evidence ??= [];
  }
  const declaredPairs = new Set<string>();
  for (const item of merged.values()) {
    if (!String(item.source ?? "").includes("declared")) {
      continue;
    }
    declaredPairs.add(JSON.stringify([item.from, item.to]));
    if (item.direction === "peer") {
      declaredPairs.add(JSON.stringify([item.to, item.from]));
    }
  }
  return [...merged.values()]
    .filter(
      (relation) =>
        !(
          relation.type === "depends_on_repo_artifacts"
          && relation.source === "detected"
          && declaredPairs.has(JSON.stringify([relation.from, relation.to]))
        ),
    )
    .sort((left, right) => {
      const leftKey = [left.from, left.to, left.type];
      const rightKey = [right.from, right.to, right.type];
      for (let index = 0; index < leftKey.length; index += 1) {
        if (leftKey[index] < rightKey[index]) return -1;
        if (leftKey[index] > rightKey[index]) return 1;
      }
      return 0;
    });
}

export function suppressRelations(
  relations: JsonObject[],
  suppressed: JsonObject[],
  suppressedTypes?: string[] | null,
): JsonObject[] {
  const keys = new Set(
    (suppressed ?? [])
      .filter((item) => ["from", "to", "type"].every((key) => key in item))
      .map((item) => JSON.stringify([item.from, item.to, item.type])),
  );
  const types = new Set(suppressedTypes ?? []);
  if (keys.size === 0 && types.size === 0) {
    return relations;
  }
  return relations.filter(
    (relation) =>
      !keys.has(JSON.stringify([relation.from, relation.to, relation.type]))
      && !types.has(relation.type),
  );
}
