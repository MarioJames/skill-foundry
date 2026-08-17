import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { requireAgentBrowser } from "./agent-browser-runtime.ts";
import {
  defaultProfile,
  fail,
  log,
  profileDir,
} from "./common.ts";

type ArtifactName =
  | "dom"
  | "console"
  | "network_xhr"
  | "network_errors"
  | "screenshot"
  | "har";

interface CommandResult {
  exitCode: number;
  stdout: string;
}

async function captureAgentBrowser(arguments_: string[]): Promise<CommandResult> {
  try {
    const child = Bun.spawn(["agent-browser", ...arguments_], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    return { exitCode, stdout };
  } catch {
    return { exitCode: 127, stdout: "" };
  }
}

async function runAgentBrowserToStderr(arguments_: string[]): Promise<number> {
  try {
    const child = Bun.spawn(["agent-browser", ...arguments_], {
      stdin: "inherit",
      stdout: 2,
      stderr: 2,
    });
    return await child.exited;
  } catch {
    return 127;
  }
}

function unwrapEnvelope(
  raw: string,
  key: string,
  fallback: unknown,
): { ok: boolean; json: string } {
  try {
    const envelope: unknown = JSON.parse(raw);
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      !("success" in envelope) ||
      envelope.success !== true ||
      !("data" in envelope) ||
      typeof envelope.data !== "object" ||
      envelope.data === null
    ) {
      throw new Error("bad envelope");
    }

    const data = envelope.data as Record<string, unknown>;
    const value = key === "-" ? data : data[key];
    if (value === undefined) throw new Error(`missing key: ${key}`);
    return { ok: true, json: JSON.stringify(value) };
  } catch {
    return { ok: false, json: JSON.stringify(fallback) };
  }
}

function localTimestamp(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function countJsonArray(path: string): number {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(value) ? value.length : 0;
  } catch {
    return 0;
  }
}

export interface EvidenceSummary {
  target: string;
  profile: string;
  profile_dir: string;
  timestamp: string;
  evidence_dir: string;
  artifacts: {
    screenshot: string;
    dom: string;
    console: string;
    network_xhr: string;
    network_errors: string;
    har?: string;
  };
  counts: {
    network_xhr: number;
    network_errors: number;
  };
  artifact_errors: ArtifactName[];
}

export async function collectEvidence(
  url: string,
  profile = "",
  har = false,
  outdirBase = "evidence",
  reusePage = false,
): Promise<EvidenceSummary> {
  requireAgentBrowser();

  const effectiveProfile = profile || defaultProfile();
  const profilePath = profileDir(effectiveProfile);
  const profileArguments = ["--profile", profilePath];

  if (har) {
    log("start HAR recording");
    await runAgentBrowserToStderr([
      "network",
      "har",
      "start",
      ...profileArguments,
    ]);
  }

  if (reusePage) {
    log(`reuse current page for ${url} (profile=${effectiveProfile})`);
  } else {
    log(`open ${url} (profile=${effectiveProfile})`);
    const openExitCode = await runAgentBrowserToStderr([
      "open",
      url,
      ...profileArguments,
    ]);
    if (openExitCode !== 0) {
      fail(3, `agent-browser open 失败：${url}`);
    }
  }

  const outdirAbsolute = isAbsolute(outdirBase)
    ? outdirBase
    : resolve(process.cwd(), outdirBase);
  let timestamp = localTimestamp();
  if (existsSync(join(outdirAbsolute, timestamp))) {
    timestamp = `${timestamp}-${process.pid}`;
  }
  const evidenceDirectory = join(outdirAbsolute, timestamp);
  mkdirSync(evidenceDirectory, { recursive: true });

  const artifactErrors: ArtifactName[] = [];
  const collectJson = async (
    label: string,
    arguments_: string[],
    key: string,
    fallback: unknown,
    filename: string,
    artifact: ArtifactName,
  ): Promise<void> => {
    log(label);
    const result = await captureAgentBrowser(arguments_);
    const unwrapped = unwrapEnvelope(result.stdout, key, fallback);
    writeFileSync(join(evidenceDirectory, filename), unwrapped.json);
    // 旧管道以信封解包结果为准；即使 CLI 非零但给出有效信封，也保留该证据。
    if (!unwrapped.ok) artifactErrors.push(artifact);
  };

  await collectJson(
    "snapshot DOM",
    ["snapshot", "--json", ...profileArguments],
    "-",
    {},
    "dom.json",
    "dom",
  );
  await collectJson(
    "console messages",
    ["console", "--json", ...profileArguments],
    "messages",
    [],
    "console.json",
    "console",
  );
  await collectJson(
    "network xhr/fetch",
    [
      "network",
      "requests",
      "--type",
      "xhr,fetch",
      "--json",
      ...profileArguments,
    ],
    "requests",
    [],
    "network-xhr.json",
    "network_xhr",
  );
  await collectJson(
    "network 4xx/5xx",
    [
      "network",
      "requests",
      "--status",
      "400-599",
      "--json",
      ...profileArguments,
    ],
    "requests",
    [],
    "network-errors.json",
    "network_errors",
  );

  log("screenshot (annotated)");
  const screenshotExitCode = await runAgentBrowserToStderr([
    "screenshot",
    "--annotate",
    join(evidenceDirectory, "screenshot.png"),
    ...profileArguments,
  ]);
  if (screenshotExitCode !== 0) artifactErrors.push("screenshot");

  if (har) {
    log("stop HAR recording");
    const harExitCode = await runAgentBrowserToStderr([
      "network",
      "har",
      "stop",
      join(evidenceDirectory, "network.har"),
      ...profileArguments,
    ]);
    if (harExitCode !== 0) artifactErrors.push("har");
  }

  const artifacts: EvidenceSummary["artifacts"] = {
    screenshot: "screenshot.png",
    dom: "dom.json",
    console: "console.json",
    network_xhr: "network-xhr.json",
    network_errors: "network-errors.json",
  };
  if (har) artifacts.har = "network.har";

  const summary: EvidenceSummary = {
    target: url,
    profile: effectiveProfile,
    profile_dir: profilePath,
    timestamp,
    evidence_dir: evidenceDirectory,
    artifacts,
    counts: {
      network_xhr: countJsonArray(join(evidenceDirectory, "network-xhr.json")),
      network_errors: countJsonArray(
        join(evidenceDirectory, "network-errors.json"),
      ),
    },
    artifact_errors: artifactErrors,
  };

  const summaryJson = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(join(evidenceDirectory, "summary.json"), summaryJson);
  process.stdout.write(summaryJson);
  return summary;
}
