import { spawnSync } from "node:child_process";

export interface RunOptions {
  captureOutput?: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class CalledProcessError extends Error {
  readonly command: string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(command: string[], result: RunResult) {
    super(`Command '${command.join(" ")}' returned non-zero exit status ${result.exitCode}.`);
    this.name = "CalledProcessError";
    this.command = [...command];
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

export type Runner = (command: string[], options?: RunOptions) => RunResult;

export const defaultRunner: Runner = (command, options = {}) => {
  const executable = command[0];
  if (!executable) {
    throw new TypeError("command must contain an executable");
  }
  const capture = options.captureOutput ?? false;
  const result = spawnSync(executable, command.slice(1), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["inherit", "inherit", "inherit"],
  });
  if (result.error) {
    throw result.error;
  }
  const runResult: RunResult = {
    stdout: capture ? result.stdout || "" : "",
    stderr: capture ? result.stderr || "" : "",
    exitCode: result.status ?? 1,
  };
  if (runResult.exitCode !== 0) {
    throw new CalledProcessError(command, runResult);
  }
  return runResult;
};

export function sleepSeconds(seconds: number): void {
  if (seconds > 0) {
    Bun.sleepSync(seconds * 1000);
  }
}
