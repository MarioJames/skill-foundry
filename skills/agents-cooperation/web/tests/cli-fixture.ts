import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Dependency-resolution boundary only: fixture HTML never imports these packages. */
export function writeSyntheticPackage(modules: string, name: string) {
  const directory = join(modules, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version: "0.0.0-test", type: "module", exports: "./index.js" }));
  writeFileSync(join(directory, "index.js"), "export {};\n");
}
