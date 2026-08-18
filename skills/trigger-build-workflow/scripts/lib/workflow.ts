import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

export type WorkflowCapabilities = {
  workflowDispatch: boolean;
  inputs: string[];
  channelInput: string | null;
  versionInput: string | null;
  changelogInput: string | null;
  changelogSummaryInput: string | null;
};

export type WorkflowCandidate = {
  name: string;
  path: string;
  compatible: boolean;
  missing: string[];
  capabilities: WorkflowCapabilities;
};

export type WorkflowDetection = {
  ok: true;
  mode: "dispatch" | "git-only";
  reason:
    | "workflow-compatible"
    | "workflow-directory-missing"
    | "workflow-not-found"
    | "no-workflow-files"
    | "no-compatible-workflow"
    | "multiple-compatible-workflows";
  repoRoot: string;
  requestedWorkflow: string | null;
  workflow: WorkflowCandidate | null;
  candidates: WorkflowCandidate[];
};

type YamlEntry = {
  indent: number;
  key: string;
  value: string;
};

function stripInlineComment(line: string): string {
  let singleQuoted = false;
  let doubleQuoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const previous = index > 0 ? line[index - 1] : "";

    if (character === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
    if (character === '"' && !singleQuoted && previous !== "\\") doubleQuoted = !doubleQuoted;
    if (character === "#" && !singleQuoted && !doubleQuoted) return line.slice(0, index);
  }

  return line;
}

function parseEntry(line: string): YamlEntry | null {
  const withoutComment = stripInlineComment(line).replace(/\s+$/, "");
  if (!withoutComment.trim() || /\t/.test(withoutComment.match(/^\s*/)?.[0] ?? "")) return null;

  const indent = withoutComment.length - withoutComment.trimStart().length;
  const content = withoutComment.trimStart();
  const match = content.match(/^(?:'([^']+)'|"([^"]+)"|([^:\s][^:]*?))\s*:\s*(.*)$/);
  if (!match) return null;

  return {
    indent,
    key: (match[1] ?? match[2] ?? match[3]).trim(),
    value: match[4].trim(),
  };
}

function blockEnd(entries: Array<YamlEntry | null>, start: number, parentIndent: number): number {
  for (let index = start + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry && entry.indent <= parentIndent) return index;
  }
  return entries.length;
}

export function inspectWorkflowText(text: string): WorkflowCapabilities {
  const entries = text.split(/\r?\n/).map(parseEntry);
  const inputs = new Set<string>();
  let workflowDispatch = false;

  for (let onIndex = 0; onIndex < entries.length; onIndex += 1) {
    const onEntry = entries[onIndex];
    if (!onEntry || onEntry.key !== "on") continue;

    if (/\bworkflow_dispatch\b/.test(onEntry.value)) workflowDispatch = true;
    const onEnd = blockEnd(entries, onIndex, onEntry.indent);

    for (let dispatchIndex = onIndex + 1; dispatchIndex < onEnd; dispatchIndex += 1) {
      const dispatchEntry = entries[dispatchIndex];
      if (!dispatchEntry || dispatchEntry.indent <= onEntry.indent || dispatchEntry.key !== "workflow_dispatch") continue;

      workflowDispatch = true;
      const dispatchEnd = Math.min(onEnd, blockEnd(entries, dispatchIndex, dispatchEntry.indent));

      for (let inputsIndex = dispatchIndex + 1; inputsIndex < dispatchEnd; inputsIndex += 1) {
        const inputsEntry = entries[inputsIndex];
        if (!inputsEntry || inputsEntry.indent <= dispatchEntry.indent || inputsEntry.key !== "inputs") continue;

        const inputsEnd = Math.min(dispatchEnd, blockEnd(entries, inputsIndex, inputsEntry.indent));
        let inputIndent: number | null = null;

        for (let inputIndex = inputsIndex + 1; inputIndex < inputsEnd; inputIndex += 1) {
          const inputEntry = entries[inputIndex];
          if (!inputEntry || inputEntry.indent <= inputsEntry.indent) continue;
          if (inputIndent === null) inputIndent = inputEntry.indent;
          if (inputEntry.indent === inputIndent) inputs.add(inputEntry.key);
        }
      }
    }
  }

  const inputList = [...inputs].sort();
  const firstSupported = (names: string[]) => names.find((name) => inputs.has(name)) ?? null;

  return {
    workflowDispatch,
    inputs: inputList,
    channelInput: firstSupported(["environment", "channel"]),
    versionInput: firstSupported(["version"]),
    changelogInput: firstSupported(["changelog", "changelog_content", "changelogContent"]),
    changelogSummaryInput: firstSupported(["changelog_summary", "changelogSummary"]),
  };
}

export function inspectWorkflowFile(path: string): WorkflowCandidate {
  const capabilities = inspectWorkflowText(readFileSync(path, "utf8"));
  const missing: string[] = [];
  if (!capabilities.workflowDispatch) missing.push("workflow_dispatch");
  if (!capabilities.channelInput) missing.push("environment/channel input");
  if (!capabilities.versionInput) missing.push("version input");
  if (!capabilities.changelogInput) missing.push("supported changelog input");

  return {
    name: basename(path),
    path,
    compatible: missing.length === 0,
    missing,
    capabilities,
  };
}

function resolveRequestedWorkflow(repoRoot: string, requested: string): string | null {
  const candidates = isAbsolute(requested)
    ? [requested]
    : [resolve(repoRoot, requested), resolve(repoRoot, ".github/workflows", requested)];

  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

export function detectBuildWorkflow(repoRoot: string, requestedWorkflow?: string): WorkflowDetection {
  const normalizedRepoRoot = resolve(repoRoot);
  const workflowDirectory = join(normalizedRepoRoot, ".github", "workflows");

  if (requestedWorkflow) {
    const requestedPath = resolveRequestedWorkflow(normalizedRepoRoot, requestedWorkflow);
    if (!requestedPath) {
      return {
        ok: true,
        mode: "git-only",
        reason: "workflow-not-found",
        repoRoot: normalizedRepoRoot,
        requestedWorkflow,
        workflow: null,
        candidates: [],
      };
    }

    const workflow = inspectWorkflowFile(requestedPath);
    return {
      ok: true,
      mode: workflow.compatible ? "dispatch" : "git-only",
      reason: workflow.compatible ? "workflow-compatible" : "no-compatible-workflow",
      repoRoot: normalizedRepoRoot,
      requestedWorkflow,
      workflow,
      candidates: [workflow],
    };
  }

  if (!existsSync(workflowDirectory) || !statSync(workflowDirectory).isDirectory()) {
    return {
      ok: true,
      mode: "git-only",
      reason: "workflow-directory-missing",
      repoRoot: normalizedRepoRoot,
      requestedWorkflow: null,
      workflow: null,
      candidates: [],
    };
  }

  const workflowPaths = readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => join(workflowDirectory, name))
    .filter((path) => statSync(path).isFile());

  if (workflowPaths.length === 0) {
    return {
      ok: true,
      mode: "git-only",
      reason: "no-workflow-files",
      repoRoot: normalizedRepoRoot,
      requestedWorkflow: null,
      workflow: null,
      candidates: [],
    };
  }

  const candidates = workflowPaths.map(inspectWorkflowFile);
  const compatible = candidates.filter((candidate) => candidate.compatible);
  const preferred = compatible.find((candidate) => /^package-orchestrator\.ya?ml$/i.test(candidate.name));

  if (preferred || compatible.length === 1) {
    return {
      ok: true,
      mode: "dispatch",
      reason: "workflow-compatible",
      repoRoot: normalizedRepoRoot,
      requestedWorkflow: null,
      workflow: preferred ?? compatible[0],
      candidates,
    };
  }

  return {
    ok: true,
    mode: "git-only",
    reason: compatible.length > 1 ? "multiple-compatible-workflows" : "no-compatible-workflow",
    repoRoot: normalizedRepoRoot,
    requestedWorkflow: null,
    workflow: null,
    candidates,
  };
}
