import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
export function directoryId(path: string) {
  const s = lstatSync(path, { bigint: true });
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("session path is not a real directory");
  return { dev: s.dev.toString(), ino: s.ino.toString() };
}
export interface Fingerprint {
  hash: string;
  entries: { relpath: string; type: string; size: string; mtime_ns: string }[];
}
export function fingerprint(path: string): Fingerprint {
  const entries: Fingerprint["entries"] = [];
  const walk = (relative: string) => {
    const p = join(path, relative),
      s = lstatSync(p, { bigint: true });
    entries.push({
      relpath: relative,
      type: s.isDirectory() ? "directory" : s.isFile() ? "file" : s.isSymbolicLink() ? "symlink" : "other",
      size: s.size.toString(),
      mtime_ns: s.mtimeNs.toString()
    });
    if (s.isDirectory()) for (const name of readdirSync(p).sort()) walk(relative ? `${relative}/${name}` : name);
  };
  walk("");
  entries.sort((a, b) => a.relpath.localeCompare(b.relpath));
  return { hash: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), entries };
}
