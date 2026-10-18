/** Survives its runtime parent; tags argv0 without passing unsupported options to Herdr. */
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2),
  split = args.indexOf("--");
if (args[0] !== "--op-tag" || !args[1] || split !== 2 || !args[3]) process.exit(2);
const result = spawnSync(args[3], args.slice(4), { argv0: `agents-cooperation-op:${args[1]}`, stdio: "inherit" });
if (result.error) {
  process.stderr.write(result.error.message + "\n");
  process.exit(1);
}
process.exit(result.status ?? 1);
