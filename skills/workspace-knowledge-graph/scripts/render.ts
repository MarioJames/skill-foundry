#!/usr/bin/env bun

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import {
  DISCOVERY_PATH,
  RELATION_INDEX_PATH,
  RELATION_REGISTRY_PATH,
  WORKSPACE_INDEX_PATH,
  readText,
  writeJson,
  writeText,
  type JsonObject,
} from "./core.ts";
import { autoRelations, mergeRelations, suppressRelations } from "./relations.ts";
import { renderAllRepoDocs } from "./render_repo.ts";
import {
  normalizeMemoryDocument,
  renderAgents,
  renderBootstrapMemory,
  renderClaude,
  renderRelationIndex,
  renderRelationRegistry,
  renderWorkspaceIndex,
  stripMemoryPlaceholder,
} from "./render_root.ts";

export function renderWorkspace(
  workspace: string,
  config: JsonObject,
  repoModels: Record<string, JsonObject>,
  discovery: JsonObject,
): void {
  let relations = mergeRelations(
    config.relations ?? [],
    autoRelations(discovery),
  );
  relations = suppressRelations(
    relations,
    config.suppressed_relations ?? [],
    config.suppressed_relation_types ?? [],
  );
  writeJson(join(workspace, DISCOVERY_PATH), discovery);
  writeJson(
    join(workspace, RELATION_REGISTRY_PATH),
    renderRelationRegistry(config, discovery, relations),
  );
  writeText(
    join(workspace, RELATION_INDEX_PATH),
    renderRelationIndex(relations, config.standalone_repos ?? [], config),
  );
  writeText(
    join(workspace, WORKSPACE_INDEX_PATH),
    renderWorkspaceIndex(workspace, config, repoModels, discovery),
  );
  writeText(
    join(workspace, "AGENTS.md"),
    renderAgents(workspace, config, discovery),
  );
  writeText(join(workspace, "CLAUDE.md"), renderClaude());
  const memoryPath = join(workspace, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    writeText(memoryPath, renderBootstrapMemory());
  } else {
    const existingMemory = readText(memoryPath);
    const normalizedMemory = normalizeMemoryDocument(existingMemory);
    const cleanedMemory = stripMemoryPlaceholder(normalizedMemory);
    if (cleanedMemory !== existingMemory) {
      writeText(memoryPath, cleanedMemory);
    }
  }
  renderAllRepoDocs(
    workspace,
    config,
    repoModels,
    discovery,
    relations,
  );
  const deleteWorkspaceMd =
    config.workspace?.entry_policy?.delete_workspace_md ?? false;
  if (deleteWorkspaceMd) {
    const legacy = join(workspace, "WORKSPACE.md");
    if (existsSync(legacy)) {
      unlinkSync(legacy);
    }
  }
}
