#!/usr/bin/env bun
import { CliError, emit, parseFlags, runCli } from "./lib/herdr-route";
import { loadRoutingConfig } from "./lib/agent-engines";
import { validateBatch, hash } from "./lib/scheduling";
import {
  StateStore,
  readJson,
  reserve,
  runAttempt,
  applyAcceptances,
  acceptAttempt,
  resolveAttempt,
} from "./lib/dispatch-state";
import {
  observeRuntime,
  transport,
  observeAttempt,
  cleanupAttempt,
  command,
} from "./lib/agent-runtime";
await runCli(async () => {
  const f = parseFlags(
    process.argv.slice(2),
    [
      "--action",
      "--input",
      "--config",
      "--state",
      "--decision",
      "--attempt",
      "--caller-pane",
      "--label",
      "--evidence",
      "--outcome",
    ],
    ["--help"],
  );
  if (f.has("--help")) {
    console.log(
      `Usage: bun dispatch-tasks.ts --state PRIVATE.json --action ACTION [options]\nActions:\n dispatch --input BATCH.json [--config agents.json] --decision ID --caller-pane ID --label 'MMDD｜FEA｜Topic'\n observe [--attempt ID]\n accept --attempt ID --evidence acceptance.json\n resolve --attempt ID --outcome not_performed|failed_stopped|cancelled_stopped --evidence proof.json\n cleanup --attempt ID --caller-pane ID\nResolve proof: {"evidence":"owner verified no live work and inspected/released affected writes"}.\nNo automatic retry, session transfer or cleanup. Observe preserves uncertain reservations.\nAccept requires exact delivered artifacts and owner evidence. State and result files remain for handoff.`,
    );
    return;
  }
  const req = (key: string) => {
    const v = f.get(key);
    if (typeof v !== "string" || !v.trim())
      throw new CliError("missing_argument", `${key} is required`, 2);
    return v;
  };
  const store = new StateStore(req("--state")),
    action = req("--action");
  await store.transaction(async (state, save) => {
    if (action === "dispatch") {
      const batch = applyAcceptances(
          validateBatch(readJson(req("--input"), 64_000)),
          state,
        ),
        config = loadRoutingConfig(f.get("--config") as string | undefined),
        id = req("--decision"),
        d = state.decisions.find((x) => x.id === id);
      if (!d) throw new CliError("unknown_decision", "Decision does not exist");
      const caller = req("--caller-pane"),
        label = req("--label");
      if (!/^\d{4}｜(?:FEA|DES|FIX|OPT|REL|EXP|DOC|RES)｜.+$/u.test(label))
        throw new CliError(
          "invalid_label",
          "Use MMDD｜TYPE｜Topic from session createdAt in Asia/Shanghai",
          2,
        );
      // Validate caller before commit; capacity and capability snapshot are refreshed under the shared lock.
      const pane = (await command(["herdr", "pane", "current", "--current"]))
        ?.result?.pane;
      if (pane?.pane_id !== caller)
        throw new CliError(
          "caller_mismatch",
          "Explicit caller must match this process caller",
        );
      const runtime = await observeRuntime(config);
      const check: { runtime: typeof runtime; status: string; error?: string } =
        { runtime, status: "pending" };
      (d.dispatch_checks ??= []).push(check);
      save();
      let attempts;
      try {
        attempts = reserve(state, d, batch, config, runtime, store.path);
        check.status = "reserved";
        save();
      } catch (error) {
        check.status = "rejected";
        check.error =
          error instanceof CliError ? error.message : "preflight_failed";
        save();
        throw error;
      }
      for (const a of attempts) {
        // Configuration is frozen at reservation; revocation/task edits still stop subsequent side effects.
        const latest = applyAcceptances(
          validateBatch(readJson(req("--input"), 64_000)),
          state,
        );
        if (hash(latest) !== hash(batch)) {
          a.phase = "cancelled";
          a.slot = "released";
          a.writes_held = false;
          a.resolution = {
            outcome: "cancelled_before_effect",
            evidence: "task snapshot changed after reservation",
          };
          save();
          continue;
        }
        await runAttempt(a, save, transport(caller, label), () => {
          const current = applyAcceptances(
            validateBatch(readJson(req("--input"), 64_000)),
            state,
          );
          if (hash(current) !== hash(batch))
            throw new CliError(
              "authorization_changed",
              "Task changed before effect",
            );
        });
      }
      emit({
        ok: true,
        status: attempts.every((a) => a.phase === "running")
          ? "running"
          : "owner_required",
        attempts,
      });
      return;
    }
    const id = f.get("--attempt"),
      a = state.attempts.find((x) => x.id === id);
    if (action === "observe") {
      for (const item of id
        ? a
          ? [a]
          : []
        : state.attempts.filter((a) => a.slot === "held")) {
        await observeAttempt(item);
        save();
      }
      if (id && !a) throw new CliError("unknown_attempt", "Attempt not found");
      emit({ ok: true, attempts: id ? [a] : state.attempts });
      return;
    }
    if (!a)
      throw new CliError(
        "unknown_attempt",
        "--attempt must name an existing attempt",
      );
    if (action === "accept")
      acceptAttempt(state, a.id, readJson(req("--evidence"), 64_000));
    else if (action === "resolve") {
      const p = readJson(req("--evidence"), 64_000);
      if (typeof p.evidence !== "string")
        throw new CliError("invalid_evidence", "proof.evidence is required");
      resolveAttempt(a, req("--outcome"), p.evidence);
    } else if (action === "cleanup") {
      if (a.cleanup)
        throw new CliError(
          "cleanup_recorded",
          "Cleanup already recorded; inspect its outcome, do not repeat blindly",
        );
      const caller = req("--caller-pane");
      if (
        (await command(["herdr", "pane", "current", "--current"]))?.result?.pane
          ?.pane_id !== caller
      )
        throw new CliError(
          "caller_mismatch",
          "Cleanup caller must match actual caller",
        );
      const cleanup = await cleanupAttempt(a, caller);
      save();
      try {
        a.cleanup = {
          ...(a.cleanup as any),
          state: "confirmed",
          reply: await cleanup.execute(),
        };
      } catch {
        a.cleanup = { ...(a.cleanup as any), state: "unknown" };
      }
    } else throw new CliError("invalid_action", "Unknown action", 2);
    save();
    emit({ ok: true, attempt: a });
  });
});
