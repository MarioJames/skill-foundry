import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { fail } from "./common.ts";

export type ResolvedTarget =
  | { kind: "url"; url: string }
  | { kind: "file"; url: string }
  | { kind: "project"; dir: string };

function isFile(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function resolveTarget(target: string): ResolvedTarget {
  if (!target) {
    fail(2, "target 不能为空：用法 bh prepare <url|html|project-dir>");
  }

  if (target.startsWith("http://") || target.startsWith("https://")) {
    return { kind: "url", url: target };
  }

  if (isFile(target)) {
    if (
      !target.endsWith(".html") &&
      !target.endsWith(".htm") &&
      !target.endsWith(".HTM")
    ) {
      fail(2, `target 文件不是 .html：${target}`);
    }
    return { kind: "file", url: `file://${resolve(target)}` };
  }

  if (isDirectory(target)) {
    if (!isFile(resolve(target, "package.json"))) {
      fail(2, `target 目录缺少 package.json：${target}`);
    }
    return { kind: "project", dir: resolve(target) };
  }

  fail(2, `target 不是 URL、.html 或项目目录：${target}`);
}
