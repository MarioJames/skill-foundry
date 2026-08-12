import {
  existsSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export function expandUser(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith(`~${sep}`)) {
    return join(homedir(), input.slice(2));
  }
  return input;
}

/** Resolve symlinks in the longest existing prefix, matching Path.resolve(strict=False). */
export function stablePath(input: string | null | undefined): string | null | undefined {
  if (!input) {
    return input;
  }
  const absolute = resolve(expandUser(input));
  const missing: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      return absolute;
    }
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  try {
    return join(realpathSync(cursor), ...missing);
  } catch {
    return absolute;
  }
}

export function operationPath(input: string): string {
  return input || ".";
}

export function isStrictDescendant(candidate: string, parent: string): boolean {
  const rel = relative(parent, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
