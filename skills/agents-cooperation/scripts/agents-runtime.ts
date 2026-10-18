#!/usr/bin/env bun
/** Herdr worker lifecycle registry. Native workers remain owned by their host. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import type { Database } from "bun:sqlite";
import { configPath, validateConfig, resolveDispatch, activeBlocks, CLASSES, type Config } from "./agents-config.ts";
import { openConfiguredState, transaction, stateWarnings, listBlocks } from "./lib/state-db.ts";
import {
  processIdentity,
  processLife,
  ownerIdentity,
  operationInFlight,
  type ProcessIdentity,
  type Life
} from "./lib/process-identity.ts";
import { directoryId, fingerprint, type Fingerprint } from "./lib/session-evidence.ts";

export interface RunRow {
  run_id: string;
  collab_id: string;
  request_id: string;
  owner_id: string;
  engine: string;
  host_session_id: string | null;
  owner_proc: string | null;
  owner_pane: string | null;
  cwd: string;
  label: string;
  session_name: string;
  session_phase: string;
  session_proof: string | null;
  session_dir_id: string | null;
  stopped_fingerprint: string | null;
  stop_observed_at: number | null;
  status: string;
  lock_proc: string | null;
  lock_op: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}
export interface LaneRow {
  lane_id: string;
  run_id: string;
  op_id: string;
  worker_id: string;
  engine: string;
  model: string;
  class: string;
  agent_name: string;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  status: string;
  outcome: string | null;
  health: string;
  keep_reason: string | null;
  last_progress_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Execute = (argv: string[], env: Record<string, string | undefined>) => CommandResult;
const execute: Execute = (argv, env) => {
  const r = Bun.spawnSync({ cmd: argv, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};
const parsed = <T>(value: string | null): T | null => (value === null ? null : JSON.parse(value));
const random = (length: number) => randomBytes(length).toString("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const procSame = (a: ProcessIdentity | null, b: ProcessIdentity | null) =>
  !!a && !!b && a.pid === b.pid && a.starttime === b.starttime && a.boot_id === b.boot_id;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Shared read/write timeout policy; retained lanes are reported after three waits without changing their health. */
function laneHealth(lane: LaneRow, ownerLife: Life, maxWaitMinutes: number, now: number) {
  const elapsed = now - lane.last_progress_at,
    max = maxWaitMinutes * 60000;
  const eligible = ownerLife !== "dead" && lane.status === "open";
  const markStale = eligible && elapsed > max && !lane.keep_reason;
  return {
    health: markStale ? "stale" : lane.health,
    markStale,
    report: eligible && (markStale || elapsed > max * 3)
  };
}

export class Runtime {
  readonly env: Record<string, string | undefined>;
  readonly exec: Execute;
  readonly home: string;
  constructor(
    readonly db: Database,
    readonly config: Config,
    options: { env?: Record<string, string | undefined>; execute?: Execute } = {}
  ) {
    this.env = options.env ?? process.env;
    this.exec = options.execute ?? execute;
    this.home = this.env.HOME ?? homedir();
    if (this.env.XDG_CONFIG_HOME && resolve(this.env.XDG_CONFIG_HOME) !== resolve(this.home, ".config"))
      throw new Error("agents-runtime only supports XDG_CONFIG_HOME at HOME/.config; no Herdr resources were accessed");
  }
  run(id: string): RunRow {
    const r = this.db.query("SELECT * FROM runs WHERE run_id=?").get(id) as RunRow | null;
    if (!r) throw new Error(`unknown run ${id}`);
    return r;
  }
  lane(id: string): LaneRow {
    const l = this.db.query("SELECT * FROM lanes WHERE lane_id=?").get(id) as LaneRow | null;
    if (!l) throw new Error(`unknown lane ${id}`);
    return l;
  }
  lanes(id: string): LaneRow[] {
    return this.db.query("SELECT * FROM lanes WHERE run_id=? ORDER BY created_at,lane_id").all(id) as LaneRow[];
  }
  updateRun(id: string, fields: Partial<RunRow>) {
    this.update("runs", "run_id", id, fields);
  }
  updateLane(id: string, fields: Partial<LaneRow>) {
    this.update("lanes", "lane_id", id, fields);
  }
  private update(table: string, key: string, id: string, fields: Record<string, unknown>) {
    const value = { ...fields, updated_at: Date.now() };
    transaction(this.db, () =>
      this.db
        .query(
          `UPDATE ${table} SET ${Object.keys(value)
            .map((k) => `${k}=?`)
            .join(",")} WHERE ${key}=?`
        )
        .run(...(Object.values(value) as any[]), id)
    );
  }
  /** The host session ID is only a recovery hint and the identity fallback when no owner process is recorded. */
  private caller(engine: string) {
    const hostVariable = engine === "claude" ? "CLAUDE_CODE_SESSION_ID" : engine === "codex" ? "CODEX_THREAD_ID" : null;
    return {
      proc: ownerIdentity(engine, this.env),
      host: (hostVariable && this.env[hostVariable]) || null
    };
  }
  authorize(run: RunRow) {
    const caller = this.caller(run.engine),
      owner = parsed<ProcessIdentity>(run.owner_proc);
    if (owner ? !procSame(owner, caller.proc) : !run.host_session_id || run.host_session_id !== caller.host)
      throw new Error("caller identity does not own this run; --run is only a locator");
  }
  openRun(input: { owner: string; collab: string; request: string; cwd: string; label: string }) {
    const owner = this.config.owners[input.owner];
    if (!owner) throw new Error(`unknown owner ${input.owner}`);
    const engine = this.config.engines[owner.engine].kind,
      caller = this.caller(engine),
      cwd = realpathSync(input.cwd);
    if (!statSync(cwd).isDirectory()) throw new Error("run cwd must be a directory");
    if (!caller.proc && !caller.host)
      throw new Error("owner process and host session identity are both missing; run open refused");
    return transaction(this.db, () => {
      const hits = this.db
        .query("SELECT * FROM runs WHERE request_id=? AND status!='closed'")
        .all(input.request) as RunRow[];
      for (const hit of hits) {
        const identity = hit.owner_proc
          ? procSame(parsed(hit.owner_proc), caller.proc)
          : hit.host_session_id === caller.host;
        if (hit.owner_id === input.owner && hit.collab_id === input.collab && hit.cwd === cwd && identity) return hit;
      }
      if (hits.length) throw new Error("request_id conflicts with different owner, collab, cwd or caller identity");
      const id = `${input.collab}-${input.owner}-${random(3)}`,
        date = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit" })
          .format(new Date())
          .replace("/", "");
      const name = `aw-${date}-${engine}-${random(4)}`;
      if (name.length > 63) throw new Error("session name exceeds 63 characters");
      const now = Date.now();
      this.db
        .query(
          "INSERT INTO runs(run_id,collab_id,request_id,owner_id,engine,host_session_id,owner_proc,owner_pane,cwd,label,session_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
        )
        .run(
          id,
          input.collab,
          input.request,
          input.owner,
          engine,
          caller.host,
          caller.proc ? JSON.stringify(caller.proc) : null,
          this.env.HERDR_PANE_ID ?? null,
          cwd,
          input.label,
          name,
          now,
          now
        );
      return this.run(id);
    });
  }
  /** A dead operation is reclaimable only when all its tagged external calls have gone. */
  withLock<T>(id: string, action: (op: string) => T): T {
    const operation = `${id}:${random(10)}`,
      self = processIdentity();
    transaction(this.db, () => {
      const run = this.run(id);
      if (run.lock_proc) {
        const holder = parsed<ProcessIdentity>(run.lock_proc)!,
          life = processLife(holder);
        if (life !== "dead") throw new Error(`run locked by ${life} operation ${run.lock_op}`);
        if (!run.lock_op || operationInFlight(run.lock_op, holder.boot_id, holder.starttime))
          throw new Error("dead lock holder still has an in-flight external operation, or no verifiable operation tag");
      }
      this.db
        .query("UPDATE runs SET lock_proc=?,lock_op=?,updated_at=? WHERE run_id=?")
        .run(JSON.stringify(self), operation, Date.now(), id);
    });
    let actionFailed = false;
    try {
      return action(operation);
    } catch (error) {
      actionFailed = true;
      throw error;
    } finally {
      let retained: string | null = null;
      try {
        if (operationInFlight(operation, self.boot_id, self.starttime))
          retained = "in-flight external operation remains";
      } catch (error) {
        retained = `cannot verify external operation completion: ${errorText(error)}`;
      }
      try {
        if (retained) {
          const previous = this.run(id).last_error;
          this.updateRun(id, { last_error: [previous, `operation lock retained: ${retained}`].filter(Boolean).join("; ") });
        } else {
          transaction(this.db, () =>
            this.db
              .query("UPDATE runs SET lock_proc=NULL,lock_op=NULL,updated_at=? WHERE run_id=? AND lock_op=?")
              .run(Date.now(), id, operation)
          );
        }
      } catch (error) {
        // Releasing or recording a diagnostic must not replace the action's original failure.
        if (!actionFailed) throw error;
        process.stderr.write(`cannot finalize operation lock ${operation}: ${errorText(error)}\n`);
      }
    }
  }
  private command(argv: string[], op: string) {
    const helper = join(import.meta.dir, "lib/external-call.ts");
    const r = this.exec([process.execPath, helper, "--op-tag", op, "--", ...argv], {
      ...this.env,
      AGENTS_COOPERATION_OP_TAG: op
    });
    if (r.code !== 0) throw new Error(`external command failed (${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  }
  private herdr(args: string[], op: string) {
    return this.command(["herdr", ...args], op);
  }
  private json(args: string[], op: string) {
    const raw = this.herdr(args, op);
    try {
      const value = JSON.parse(raw);
      if (value.error || value.ok === false) throw new Error(raw);
      return value.result ?? value;
    } catch {
      throw new Error(`invalid Herdr response: ${raw}`);
    }
  }
  private sessionPath(run: RunRow) {
    return join(this.home, ".config/herdr/sessions", run.session_name);
  }
  private sessions(op: string): { name: string; status: string }[] {
    const text = this.herdr(["session", "list"], op).trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      const value = JSON.parse(text),
        rows = Array.isArray(value) ? value : (value.result?.sessions ?? value.sessions);
      if (
        !Array.isArray(rows) ||
        rows.some((r) => typeof r.name !== "string" || !["running", "stopped"].includes(r.status))
      )
        throw new Error("invalid session inventory");
      return rows;
    }
    if (!/^name\s+status\s+/i.test(text)) throw new Error("invalid session inventory");
    return text
      .split("\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => {
        const [name, status] = line.trim().split(/\s+/);
        if (!["running", "stopped"].includes(status)) throw new Error("invalid session status");
        return { name, status };
      });
  }
  private sessionStatus(run: RunRow, op: string) {
    return this.sessions(op).find((s) => s.name === run.session_name)?.status ?? "absent";
  }
  private dirMatches(run: RunRow) {
    try {
      return run.session_dir_id !== null && same(directoryId(this.sessionPath(run)), parsed(run.session_dir_id));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as any).code)) return false;
      throw error;
    }
  }
  private unknown(run: RunRow, message: string): never {
    this.updateRun(run.run_id, { session_phase: "unknown", last_error: message });
    throw new Error(message);
  }
  private verifyRunning(run: RunRow, op: string) {
    if (!run.session_proof || !run.session_dir_id) return this.unknown(run, "session has no ownership proof");
    try {
      if (!this.dirMatches(run)) return this.unknown(run, "session directory identity changed");
      const proof = parsed<any>(run.session_proof)!;
      if (
        processLife({
          pid: proof.server_pid,
          starttime: String(proof.server_starttime),
          boot_id: proof.boot_id,
          source: "server"
        }) !== "alive"
      )
        return this.unknown(run, "original server is no longer alive");
      const invocation = this.command(
        ["systemctl", "--user", "show", proof.unit, "--property=InvocationID", "--value"],
        op
      ).trim();
      if (!invocation || invocation !== proof.invocation_id)
        return this.unknown(run, "session scope invocation changed");
      if (this.sessionStatus(run, op) !== "running") return this.unknown(run, "session is not running");
    } catch (error) {
      if (this.run(run.run_id).session_phase === "unknown") throw error;
      throw new Error(`cannot verify running session: ${errorText(error)}`);
    }
  }
  private inventory(run: RunRow, op: string) {
    const prefix = ["--session", run.session_name],
      result = { workspaces: [] as string[], tabs: [] as string[], panes: [] as string[] };
    const ids = (value: any, key: string, field: string): string[] => {
      const rows = value?.[key];
      if (!Array.isArray(rows) || rows.some((r) => typeof r[field] !== "string" || !r[field]))
        throw new Error(`invalid ${key} inventory`);
      return rows.map((r) => r[field]);
    };
    result.workspaces = ids(this.json([...prefix, "workspace", "list"], op), "workspaces", "workspace_id");
    for (const workspace of result.workspaces) {
      result.tabs.push(...ids(this.json([...prefix, "tab", "list", "--workspace", workspace], op), "tabs", "tab_id"));
      result.panes.push(
        ...ids(this.json([...prefix, "pane", "list", "--workspace", workspace], op), "panes", "pane_id")
      );
    }
    return result;
  }
  private recoverCreating(run: RunRow) {
    if (run.session_phase === "creating")
      this.unknown(
        run,
        "interrupted session creation has no committed ownership receipt; refusing name-based adoption"
      );
  }
  openLane(input: { run: string; worker: string; class: string; name: string; op: string }) {
    this.authorize(this.run(input.run));
    const gcReports = this.gc(input.run).reports;
    const result = this.withLock(input.run, (op) => {
      let run = this.run(input.run);
      this.authorize(run);
      if (run.status !== "active") throw new Error("run is not active");
      this.recoverCreating(run);
      if (!CLASSES.includes(input.class)) throw new Error("invalid lane class");
      const worker = this.config.workers[input.worker];
      if (!worker) throw new Error(`unknown worker ${input.worker}`);
      const existing = this.db
        .query("SELECT * FROM lanes WHERE run_id=? AND op_id=?")
        .get(run.run_id, input.op) as LaneRow | null;
      if (existing) {
        if (
          existing.worker_id !== input.worker ||
          existing.class !== input.class ||
          existing.agent_name !== input.name ||
          existing.engine !== worker.engine ||
          existing.model !== worker.model
        )
          throw new Error("lane op_id conflicts with different parameters");
        if (existing.status === "opening") {
          this.updateLane(existing.lane_id, {
            status: "unknown",
            last_error: "opening receipt missing; refusing label-based adoption"
          });
          return this.lane(existing.lane_id);
        }
        return existing;
      }
      const dispatch = resolveDispatch(
        this.config,
        activeBlocks({ version: 1, blocks: listBlocks(this.db) }, Date.now()),
        { owner: run.owner_id, worker: input.worker }
      );
      if (dispatch.dispatch !== "herdr")
        throw new Error("native workers are managed by the host and cannot open Herdr lanes");
      if (!["none", "created"].includes(run.session_phase))
        throw new Error(`session phase ${run.session_phase} does not allow new lanes`);
      if (run.session_phase === "created") this.verifyRunning(run, op);
      const laneId = `lane-${random(8)}`,
        now = Date.now();
      transaction(this.db, () =>
        this.db
          .query(
            "INSERT INTO lanes(lane_id,run_id,op_id,worker_id,engine,model,class,agent_name,status,last_progress_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'opening',?,?,?)"
          )
          .run(
            laneId,
            run.run_id,
            input.op,
            input.worker,
            worker.engine,
            worker.model,
            input.class,
            input.name,
            now,
            now,
            now
          )
      );
      const first = run.session_phase === "none";
      if (first) {
        this.updateRun(run.run_id, { session_phase: "creating" });
        run = this.run(run.run_id);
      }
      try {
        const route = resolve(import.meta.dir, "../../herdr/scripts/route-lane.ts");
        if (!existsSync(route)) throw new Error(`route-lane not found at ${route}; install sibling herdr skill`);
        const raw = this.command(
          [
            process.execPath,
            route,
            "--type",
            "coding-agent",
            "--cwd",
            run.cwd,
            "--label",
            run.label,
            first ? "--create-session" : "--session",
            run.session_name,
            ...(!first ? ["--require-running"] : []),
            "--op-tag",
            op
          ],
          op
        );
        const receipt = JSON.parse(raw),
          session = receipt.session,
          ids = receipt.result;
        if (
          !receipt.ok ||
          session?.name !== run.session_name ||
          session?.created !== first ||
          (!first && session?.started === true) ||
          !ids ||
          ["workspace_id", "tab_id", "pane_id"].some((k) => typeof ids[k] !== "string" || !ids[k])
        )
          throw new Error("invalid route-lane receipt");
        if (first) {
          const p = session.proof,
            d = session.dir_id;
          if (
            !p ||
            p.unit !== `herdr-session-${run.session_name}.scope` ||
            typeof p.invocation_id !== "string" ||
            !p.invocation_id ||
            !Number.isInteger(p.server_pid) ||
            !/^\d+$/.test(String(p.server_starttime)) ||
            typeof p.boot_id !== "string" ||
            !d ||
            d.dev === undefined ||
            d.ino === undefined
          )
            throw new Error("session creation receipt missing proof");
          this.updateRun(run.run_id, {
            session_proof: JSON.stringify(p),
            session_dir_id: JSON.stringify({ dev: String(d.dev), ino: String(d.ino) }),
            session_phase: "created"
          });
        }
        this.verifyRunning(this.run(run.run_id), op);
        this.updateLane(laneId, {
          status: "open",
          workspace_id: ids.workspace_id,
          tab_id: ids.tab_id,
          pane_id: ids.pane_id,
          last_error: null
        });
      } catch (error) {
        this.updateLane(laneId, { status: "unknown", last_error: errorText(error) });
        if (first) this.updateRun(run.run_id, { session_phase: "unknown", last_error: errorText(error) });
        throw error;
      }
      return this.lane(laneId);
    });
    return { ...result, gc_reports: gcReports };
  }
  closeLane(id: string) {
    const lane = this.lane(id);
    this.authorize(this.run(lane.run_id));
    return this.withLock(lane.run_id, (op) => this.closeLaneLocked(id, op));
  }
  private closeLaneLocked(id: string, op: string) {
    let lane = this.lane(id);
    if (lane.status === "closed") return lane;
    if (!lane.pane_id || ["unknown", "opening"].includes(lane.status))
      throw new Error(`lane ${id} has unknown resource ownership`);
    const run = this.run(lane.run_id);
    this.verifyRunning(run, op);
    this.updateLane(id, { status: "closing" });
    try {
      if (this.inventory(run, op).panes.includes(lane.pane_id))
        this.herdr(["--session", run.session_name, "pane", "close", lane.pane_id], op);
      if (this.inventory(run, op).panes.includes(lane.pane_id)) throw new Error("pane still present after close");
      this.updateLane(id, { status: "closed", closed_at: Date.now(), last_error: null });
    } catch (error) {
      this.updateLane(id, { last_error: errorText(error) });
      throw error;
    }
    return this.lane(id);
  }
  markLane(id: string, input: { outcome?: string; keepReason?: string; progress?: boolean }) {
    const lane = this.lane(id);
    this.authorize(this.run(lane.run_id));
    if (input.outcome && !["accepted", "failed"].includes(input.outcome))
      throw new Error("outcome must be accepted|failed");
    return this.withLock(lane.run_id, () => {
      const patch: Partial<LaneRow> = {};
      if (input.outcome) patch.outcome = input.outcome;
      if (input.keepReason !== undefined) patch.keep_reason = input.keepReason || null;
      if (input.progress) {
        patch.last_progress_at = Date.now();
        patch.health = "ok";
      }
      this.updateLane(id, patch);
      return this.lane(id);
    });
  }
  closeRun(id: string) {
    this.authorize(this.run(id));
    const gcReports = this.gc(id).reports;
    const result = this.withLock(id, (op) => {
      this.authorize(this.run(id));
      if (this.run(id).status === "closed") return this.run(id);
      this.updateRun(id, { status: "closing" });
      this.resumeClose(id, op);
      return this.run(id);
    });
    return { ...result, gc_reports: gcReports };
  }
  private assertEmpty(run: RunRow, op: string) {
    const lanes = this.lanes(run.run_id);
    if (lanes.some((l) => l.status !== "closed")) throw new Error("unclosed or unknown lanes prevent session stop");
    const inv = this.inventory(run, op);
    if (inv.workspaces.length || inv.tabs.length || inv.panes.length)
      throw new Error(`unknown resources prevent session stop: ${JSON.stringify(inv)}`);
  }
  private verifyStopped(run: RunRow, op: string) {
    if (this.sessionStatus(run, op) !== "stopped") this.unknown(run, "session is no longer stopped");
    if (!this.dirMatches(run)) this.unknown(run, "stopped directory identity changed");
    const recorded = parsed<Fingerprint>(run.stopped_fingerprint);
    let current: Fingerprint;
    try {
      current = fingerprint(this.sessionPath(run));
    } catch (error) {
      this.unknown(run, `cannot verify stopped directory fingerprint; preserving session: ${errorText(error)}`);
    }
    if (!recorded || !same(recorded, current!))
      this.unknown(run, "stopped directory fingerprint changed; preserving session");
  }
  private captureStopped(run: RunRow, op: string, fresh: boolean) {
    if (this.sessionStatus(run, op) !== "stopped") throw new Error("stop did not reach stopped state");
    const proof = parsed<any>(run.session_proof);
    if (!proof) throw new Error("original server proof missing");
    const server = {
      pid: proof.server_pid,
      starttime: String(proof.server_starttime),
      boot_id: proof.boot_id,
      source: "server"
    };
    if (fresh) for (let attempt = 0; attempt < 100 && processLife(server) === "alive"; attempt++) Bun.sleepSync(10);
    if (processLife(server) !== "dead") throw new Error("original server exit not confirmed");
    if (!this.dirMatches(run)) this.unknown(run, "session directory changed during stop");
    if (fresh) {
      this.updateRun(run.run_id, { stop_observed_at: Date.now() });
      run = this.run(run.run_id);
    }
    const fp = fingerprint(this.sessionPath(run));
    if (!run.stop_observed_at || fp.entries.some((e) => BigInt(e.mtime_ns) > BigInt(run.stop_observed_at!) * 1000000n))
      this.unknown(run, "no trustworthy stop-time evidence for stopped directory generation");
    this.updateRun(run.run_id, { session_phase: "stopped", stopped_fingerprint: JSON.stringify(fp), last_error: null });
  }
  /** Caller owns the run lock; each destructive action is preceded by a durable phase. */
  resumeClose(id: string, op: string) {
    try {
      let run = this.run(id);
      if (run.session_phase === "none") {
        this.updateRun(id, { status: "closed", closed_at: Date.now(), last_error: null });
        return;
      }
      if (run.session_phase === "creating") this.recoverCreating(run);
      if (run.session_phase === "unknown") throw new Error("unknown session ownership; manual inspection required");
      if (run.session_phase === "created") {
        const errors: string[] = [];
        for (const lane of this.lanes(id)) {
          if (lane.status === "closed") continue;
          try {
            this.closeLaneLocked(lane.lane_id, op);
          } catch (error) {
            errors.push(`lane ${lane.lane_id}: ${errorText(error)}`);
          }
        }
        if (errors.length) throw new Error(errors.join("; "));
        this.assertEmpty(run, op);
        this.verifyRunning(run, op);
        this.updateRun(id, { session_phase: "stopping" });
        run = this.run(id);
        this.herdr(["session", "stop", run.session_name], op);
        this.captureStopped(run, op, true);
      } else if (run.session_phase === "stopping") {
        const state = this.sessionStatus(run, op);
        if (state === "running") {
          this.verifyRunning(run, op);
          this.assertEmpty(run, op);
          this.herdr(["session", "stop", run.session_name], op);
          this.captureStopped(run, op, true);
        } else if (state === "stopped") this.captureStopped(run, op, false);
        else this.unknown(run, "session disappeared while stopping");
      }
      run = this.run(id);
      if (run.session_phase === "stopped") {
        this.verifyStopped(run, op);
        this.updateRun(id, { session_phase: "deleting" });
      }
      run = this.run(id);
      if (run.session_phase === "deleting") {
        const state = this.sessionStatus(run, op),
          exists = existsSync(this.sessionPath(run));
        if (state === "absent" && !exists) this.updateRun(id, { session_phase: "deleted" });
        else {
          this.verifyStopped(run, op);
          this.herdr(["session", "delete", run.session_name], op);
          if (this.sessionStatus(run, op) !== "absent" || existsSync(this.sessionPath(run)))
            throw new Error("session deletion not confirmed");
          this.updateRun(id, { session_phase: "deleted" });
        }
      }
      if (this.run(id).session_phase === "deleted")
        this.updateRun(id, { status: "closed", closed_at: Date.now(), last_error: null });
    } catch (error) {
      this.updateRun(id, { last_error: errorText(error) });
      throw error;
    }
  }
  gc(skip?: string) {
    const reports: any[] = [];
    const runs = this.db.query("SELECT * FROM runs WHERE status!='closed'").all() as RunRow[];
    for (const row of runs) {
      if (row.run_id === skip) continue;
      try {
        this.withLock(row.run_id, (op) => {
          let run = this.run(row.run_id),
            life = processLife(parsed(run.owner_proc));
          const from = run.session_phase;
          if (run.session_phase === "creating") {
            try {
              this.recoverCreating(run);
            } catch (error) {
              reports.push({ run: run.run_id, error: errorText(error) });
            }
            run = this.run(run.run_id);
          }
          for (const lane of this.lanes(run.run_id)) {
            if (lane.status === "opening") {
              this.updateLane(lane.lane_id, {
                status: "unknown",
                last_error: "opening receipt missing; refusing label-based adoption"
              });
              reports.push({ lane_id: lane.lane_id, action: "marked_unknown", from: "opening" });
            }
            if (lane.status === "closing" && run.session_phase === "created") {
              try {
                this.closeLaneLocked(lane.lane_id, op);
                reports.push({ lane_id: lane.lane_id, action: "closed", from: "closing" });
              } catch (error) {
                reports.push({ lane: lane.lane_id, error: errorText(error) });
              }
            }
            const health = laneHealth(lane, life, this.config.herdr.max_wait_minutes, Date.now());
            if (health.report) {
              if (health.markStale) this.updateLane(lane.lane_id, { health: "stale" });
              reports.push({ lane: lane.lane_id, health: "stale", owner: life, keep_reason: lane.keep_reason });
            }
          }
          if (run.status === "closing" || life === "dead") {
            const reclaimed = run.status !== "closing";
            if (reclaimed) this.updateRun(run.run_id, { status: "closing" });
            try {
              this.resumeClose(run.run_id, op);
            } finally {
              const to = this.run(run.run_id).session_phase;
              reports.push(
                reclaimed
                  ? { run_id: run.run_id, action: "reclaimed", owner_life: life, session_phase: to }
                  : { run_id: run.run_id, action: "resumed", from, to }
              );
            }
          }
        });
      } catch (error) {
        reports.push({ run: row.run_id, error: errorText(error) });
      }
    }
    try {
      const registered = this.db.query("SELECT session_name FROM runs WHERE status!='closed'").all() as {
        session_name: string;
      }[];
      for (const s of this.sessions(`gc-scan:${random(10)}`))
        if (s.name.startsWith("aw-") && !registered.some((r) => r.session_name === s.name))
          reports.push({ session: s.name, status: s.status, error: "unregistered session; report only" });
    } catch (error) {
      reports.push({ error: `session inventory failed: ${errorText(error)}` });
    }
    return { reports };
  }
  ls(id?: string, all = false) {
    const runs = (
      id ? [this.run(id)] : this.db.query(`SELECT * FROM runs ${all ? "" : "WHERE status!='closed'"}`).all()
    ) as RunRow[];
    const now = Date.now();
    return {
      runs: runs.map((run) => {
        const ownerLife = processLife(parsed<ProcessIdentity>(run.owner_proc));
        let actual: unknown;
        const op = `ls:${random(10)}`;
        try {
          const status = this.sessionStatus(run, op);
          if (status === "running") {
            const inventory = this.inventory(run, op),
              lanes = this.lanes(run.run_id);
            const known = {
              workspaces: lanes.map((l) => l.workspace_id).filter(Boolean),
              tabs: lanes.map((l) => l.tab_id).filter(Boolean),
              panes: lanes.map((l) => l.pane_id).filter(Boolean)
            };
            const unknown = Object.fromEntries(
              Object.entries(inventory).map(([key, ids]) => [
                key,
                ids.filter((id) => !(known as any)[key].includes(id))
              ])
            );
            const missing = lanes
              .filter((l) => l.status !== "closed" && l.pane_id && !inventory.panes.includes(l.pane_id))
              .map((l) => ({ lane_id: l.lane_id, pane_id: l.pane_id }));
            actual = { status, inventory, unknown, missing };
          } else
            actual = {
              status,
              missing: this.lanes(run.run_id)
                .filter((l) => l.status !== "closed")
                .map((l) => ({ lane_id: l.lane_id, pane_id: l.pane_id }))
            };
        } catch (error) {
          actual = { error: errorText(error) };
        }
        return {
          ...run,
          owner_life: ownerLife,
          lanes: this.lanes(run.run_id).map((lane) => ({
            ...lane,
            health: laneHealth(lane, ownerLife, this.config.herdr.max_wait_minutes, now).health
          })),
          actual
        };
      })
    };
  }
}
const USAGE = `Usage: bun agents-runtime.ts <command> [options]
  run open --owner <id> --collab <collab-id> --request <request-id> --cwd <path> --label <text>
                                   Register an owner run and reserve its private session name
  run close --run <run-id>          Close registered lanes, then stop and delete an empty owned session
  lane open --run <run-id> --worker <id> --class mechanical|routine|judgment --name <agent-name> --op <op-id>
                                   Create or recover a Herdr worker lane; does not start an agent
  lane close --lane <lane-id>       Close only the lane's registered pane
  lane mark --lane <lane-id> [--outcome accepted|failed] [--keep-reason <text>] [--progress]
                                   Record outcome, retention reason or progress without changing lifecycle status;
                                   at least one mark option is required
  ls [--run <run-id>] [--all]        Compare registered runs and lanes with actual resources without refreshing progress
  gc                               Recover interrupted cleanup and runs whose owners are confirmed dead;
                                   report stale lanes, unknown ownership and unregistered sessions
Common: --config <path> --state <sqlite-file>; env AGENTS_COOPERATION_CONFIG, AGENTS_COOPERATION_STATE
  --help                           Show this help`;
export function runRuntime(args: string[], env: Record<string, string | undefined> = process.env): CommandResult {
  let db: Database | undefined;
  try {
    const options: any = Object.fromEntries(
      [
        "state",
        "config",
        "owner",
        "collab",
        "request",
        "cwd",
        "label",
        "run",
        "worker",
        "class",
        "name",
        "op",
        "lane",
        "outcome",
        "keep-reason"
      ].map((k) => [k, { type: "string" }])
    );
    options.progress = { type: "boolean" };
    options.all = { type: "boolean" };
    options.help = { type: "boolean" };
    const { values: v, positionals: p } = parseArgs({ args, allowPositionals: true, options });
    if (v.help) return { code: 0, stdout: USAGE + "\n", stderr: "" };
    const need = (key: string) => {
      if (typeof v[key] !== "string" || !v[key]) throw new Error(`--${key} is required`);
      return v[key] as string;
    };
    const config = JSON.parse(readFileSync(configPath(v.config as string | undefined, env).path, "utf8"));
    const issues = validateConfig(config);
    if (issues.length) throw new Error(`invalid config: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    db = openConfiguredState(v.state as string | undefined, env);
    const runtime = new Runtime(db, config, { env });
    let result: unknown;
    const command = p.join(" ");
    switch (command) {
      case "run open":
        result = runtime.openRun({
          owner: need("owner"),
          collab: need("collab"),
          request: need("request"),
          cwd: need("cwd"),
          label: need("label")
        });
        break;
      case "run close":
        result = runtime.closeRun(need("run"));
        break;
      case "lane open":
        result = runtime.openLane({
          run: need("run"),
          worker: need("worker"),
          class: need("class"),
          name: need("name"),
          op: need("op")
        });
        break;
      case "lane close":
        result = runtime.closeLane(need("lane"));
        break;
      case "lane mark":
        if (!v.outcome && v["keep-reason"] === undefined && !v.progress)
          throw new Error("lane mark requires --outcome, --keep-reason or --progress");
        result = runtime.markLane(need("lane"), {
          outcome: v.outcome as string | undefined,
          keepReason: v["keep-reason"] as string | undefined,
          progress: v.progress as boolean
        });
        break;
      case "gc":
        result = runtime.gc();
        break;
      case "ls":
        result = runtime.ls(v.run as string | undefined, !!v.all);
        break;
      default:
        throw new Error(USAGE);
    }
    return {
      code: 0,
      stdout:
        JSON.stringify(
          stateWarnings(db).length ? { ...(result as object), state_warnings: stateWarnings(db) } : result,
          null,
          2
        ) + "\n",
      stderr: ""
    };
  } catch (error) {
    return { code: 1, stdout: "", stderr: `agents-runtime: ${errorText(error)}\n` };
  } finally {
    db?.close();
  }
}
if (import.meta.main) {
  const r = runRuntime(process.argv.slice(2));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.code);
}
