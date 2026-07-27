import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

import * as stateStore from "./state_store.ts";
import { RuntimeError, type RuntimeRecord } from "./runtime_types.ts";

export const SEED_BYTES = 32;

function secretRoot(): string {
  const root = join(stateStore.runtimeRoot(), "secrets");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return resolve(root);
}

export function seedRef(rootId: string): string {
  return `secrets/${rootId}.key`;
}

export function resolveSeedPath(reference: unknown): string {
  if (typeof reference !== "string" || !reference) {
    throw new RuntimeError("Run child token seed reference is missing");
  }
  const parts = reference.split("/");
  if (isAbsolute(reference) || parts.includes("..") || parts[0] !== "secrets" || parts.length !== 2) {
    throw new RuntimeError("Run child token seed reference is invalid");
  }
  const path = resolve(stateStore.runtimeRoot(), ...parts);
  if (dirname(path) !== secretRoot()) throw new RuntimeError("Run child token seed escapes the secret directory");
  return path;
}

export function createRunSeed(rootId: string): [string, string] {
  const reference = seedRef(rootId);
  const path = resolveSeedPath(reference);
  const seed = randomBytes(SEED_BYTES);
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  try {
    writeSync(descriptor, seed);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
  return [reference, createHash("sha256").update(seed).digest("hex")];
}

function readSeed(run: RuntimeRecord): Buffer {
  const path = resolveSeedPath(run.token_seed_ref);
  let seed: Buffer;
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) {
      throw new RuntimeError("Run child token seed must have mode 0600");
    }
    seed = readFileSync(path);
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError("Run child token seed is unavailable");
  }
  if (seed.byteLength !== SEED_BYTES) throw new RuntimeError("Run child token seed has an invalid length");
  const expected = run.token_seed_hash;
  const actual = createHash("sha256").update(seed).digest();
  if (typeof expected !== "string") throw new RuntimeError("Run child token seed hash does not match");
  const expectedBytes = Buffer.from(expected, "hex");
  if (expectedBytes.byteLength !== actual.byteLength || !timingSafeEqual(actual, expectedBytes)) {
    throw new RuntimeError("Run child token seed hash does not match");
  }
  return seed;
}

export function deriveAttemptToken(run: RuntimeRecord, attemptId: number): string {
  const digest = createHmac("sha256", readSeed(run))
    .update(`${run.root_id}|${attemptId}`, "utf8")
    .digest();
  return digest.toString("base64url");
}

export function removeRunSeed(run: RuntimeRecord | null): boolean {
  const reference = run?.token_seed_ref;
  if (!reference) return true;
  const path = resolveSeedPath(reference);
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return !existsSync(path);
}

export function cleanupRunSeedIfSafe(rootId: string): boolean {
  const result = stateStore.transaction((connection) => {
    const run = stateStore.getRun(rootId, connection);
    if (run === null || !new Set(["done", "failed", "cancelled"]).has(run.status)) {
      return { safe: false, run };
    }
    const openEffects = Number(connection.execute(
      `SELECT COUNT(*) AS n FROM effects
        WHERE root_id=? AND effect_type IN ('spawn_agent','stop_agent')
          AND status IN ('pending','running')`,
      [rootId],
    ).fetchone()?.n ?? 0);
    const openExecutions = Number(connection.execute(
      `SELECT COUNT(*) AS n FROM launches l
        JOIN attempts a ON a.attempt_id=l.attempt_id
        JOIN tasks t ON t.task_id=a.task_id
       WHERE t.root_id=? AND l.status != 'closed'`,
      [rootId],
    ).fetchone()?.n ?? 0);
    return { safe: openEffects === 0 && openExecutions === 0, run };
  }, false);
  return result.safe && result.run !== null ? removeRunSeed(result.run) : false;
}
