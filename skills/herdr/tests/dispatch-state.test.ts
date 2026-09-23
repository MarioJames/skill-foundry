import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StateStore,
  reserve,
  runAttempt,
  acceptAttempt,
  resolveAttempt,
} from "../scripts/lib/dispatch-state";
import { validateBatch, hash } from "../scripts/lib/scheduling";
import {
  prepareAssessment,
  prepareWave,
  resolveWave,
} from "../scripts/lib/jev-decision";
import { buildLaunch } from "../scripts/lib/agent-engines";
const fixture = () => {
  const b = validateBatch(
    JSON.parse(
      readFileSync(
        new URL("../examples/jev-batch.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  b.tasks.forEach(
    (t) =>
      (t.owner_assessment = {
        complexity: "moderate",
        evidence: "bounded contract",
      }),
  );
  const c = JSON.parse(
    readFileSync(new URL("../examples/agents.json", import.meta.url), "utf8"),
  );
  const r: any = {
    observed_at: new Date().toISOString(),
    agents: [],
    probes: Object.fromEntries(
      Object.entries(c.routes).map(([k, p]: any) => [
        k,
        {
          status: "supported",
          profile: p,
          launch: buildLaunch(c, p),
          cli_version: "fixture",
          adapter_version: "1",
          checked_at: new Date().toISOString(),
          reason: "fixture",
          evidence: [],
        },
      ]),
    ),
  };
  const a = prepareAssessment(b, {}).cached;
  const p = prepareWave(b, c, a, r, []);
  return { b, c, r, p, a };
};
async function sandbox(work: (s: StateStore, d: string) => Promise<void>) {
  const d = mkdtempSync(join(tmpdir(), "herdr-state-"));
  try {
    await work(new StateStore(join(d, "state.json")), d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
function decision(f: ReturnType<typeof fixture>) {
  return {
    id: "decision-1",
    created_at: new Date().toISOString(),
    input_hash: hash(f.b),
    prepared: f.p,
    result: { status: "selected", assignments: f.p.waves[0].assignments },
    assessment_request: null,
    assessment_response: null,
    wave_response: null,
  };
}

test("atomic reservation prevents duplicate decision dispatch and preserves full immutable binding", async () =>
  sandbox(async (s) => {
    const f = fixture();
    await s.transaction(async (state, save) => {
      state.decisions.push(decision(f));
      reserve(state, decision(f), f.b, f.c, f.r, s.path);
      save();
    });
    expect(s.read().attempts).toHaveLength(2);
    expect(s.read().attempts[0].binding.task.summary).toBe(
      f.b.tasks[0].summary,
    );
    await expect(
      s.transaction(async (state) => {
        reserve(state, decision(f), f.b, f.c, f.r, s.path);
      }),
    ).rejects.toThrow();
    expect(s.read().attempts).toHaveLength(2);
  }));
test("exclusive lock rejects concurrent writers and removes only own lock", async () =>
  sandbox(async (s) => {
    await s.transaction(async () => {
      await expect(s.transaction(async () => {})).rejects.toThrow("locked");
    });
    await s.transaction(async () => {});
  }));
test("config/task drift and fresh unknown capability invalidate before reservation", async () =>
  sandbox(async (s) => {
    for (const mutate of [
      (f: any) => f.c.limits.max_parallel++,
      (f: any) => f.b.tasks[0].revision++,
      (f: any) => (f.r.probes.moderate.status = "unknown"),
    ]) {
      const f = fixture(),
        d = decision(f);
      d.prepared = structuredClone(d.prepared);
      mutate(f);
      await expect(
        s.transaction(async (state) => {
          reserve(state, d, f.b, f.c, f.r, s.path);
        }),
      ).rejects.toThrow();
      expect(s.read().attempts).toHaveLength(0);
    }
  }));
test("lost side-effect reply leaves durable unknown; restart never creates or submits again", async () =>
  sandbox(async (s) => {
    const f = fixture();
    let calls = 0;
    await s.transaction(async (state, save) => {
      const [a] = reserve(state, decision(f), f.b, f.c, f.r, s.path);
      save();
      await runAttempt(a, save, {
        create: async () => {
          calls++;
          throw Error("lost reply");
        },
        start: async () => {
          throw Error("unexpected");
        },
        submit: async () => {
          throw Error("unexpected");
        },
      });
    });
    expect(calls).toBe(1);
    const a = s.read().attempts[0];
    expect(a.effects[0].state).toBe("unknown");
    expect(a.slot).toBe("held");
    await s.transaction(async (state, save) => {
      await expect(
        runAttempt(state.attempts[0], save, {
          create: async () => {
            calls++;
            return {} as any;
          },
          start: async () => ({}),
          submit: async () => ({}),
        }),
      ).rejects.toThrow();
    });
    expect(calls).toBe(1);
  }));
test("acceptance needs delivered artifacts and exact revision; finish alone retains writes", async () =>
  sandbox(async (s) => {
    const f = fixture();
    await s.transaction(async (state, save) => {
      const [a] = reserve(state, decision(f), f.b, f.c, f.r, s.path);
      a.phase = "finished";
      a.slot = "released";
      a.result = {
        attempt_id: a.id,
        task_id: a.task.id,
        task_revision: a.task.revision,
        status: "completed",
        summary: "done",
        artifact_refs: ["commit:abc"],
      };
      expect(() =>
        acceptAttempt(state, a.id, {
          task_revision: 2,
          attempt_id: a.id,
          artifact_refs: ["commit:abc"],
          delivery_evidence_ref: "proof",
          owner_evidence_ref: "review",
        }),
      ).toThrow();
      expect(() =>
        acceptAttempt(state, a.id, {
          task_revision: 1,
          attempt_id: a.id,
          artifact_refs: ["invented"],
          delivery_evidence_ref: "proof",
          owner_evidence_ref: "review",
        }),
      ).toThrow();
      expect(a.writes_held).toBe(true);
      acceptAttempt(state, a.id, {
        task_revision: 1,
        attempt_id: a.id,
        artifact_refs: ["commit:abc"],
        delivery_evidence_ref: "proof",
        owner_evidence_ref: "review",
      });
      expect(a.writes_held).toBe(false);
      save();
    });
  }));
test("owner reconciliation records evidence without retrying uncertain side effects", async () =>
  sandbox(async (s) => {
    const f = fixture();
    await s.transaction(async (state, save) => {
      const [a] = reserve(state, decision(f), f.b, f.c, f.r, s.path);
      resolveAttempt(
        a,
        "not_performed",
        "owner checked pane inventory and no lane was created",
      );
      expect(a.slot).toBe("released");
      expect(a.writes_held).toBe(false);
      expect(a.resolution?.evidence).toContain("owner");
      save();
    });
  }));

test("owner-terminated and competing same-revision attempts cannot enter acceptance", async () =>
  sandbox(async (s) => {
    const f = fixture();
    await s.transaction(async (state) => {
      const [a] = reserve(state, decision(f), f.b, f.c, f.r, s.path);
      const proof = {
        task_revision: a.task.revision,
        attempt_id: a.id,
        artifact_refs: ["artifact"],
        delivery_evidence_ref: "delivery",
        owner_evidence_ref: "review",
      };
      a.phase = "finished";
      a.slot = "released";
      a.result = {
        attempt_id: a.id,
        task_id: a.task.id,
        task_revision: a.task.revision,
        status: "completed",
        summary: "done",
        artifact_refs: ["artifact"],
      };
      a.resolution = { outcome: "failed_stopped", evidence: "failed review" };
      expect(() => acceptAttempt(state, a.id, proof)).toThrow();
      delete a.resolution;
      const other = structuredClone(a);
      other.id = "other";
      other.acceptance = { ...proof, attempt_id: "other" };
      other.writes_held = false;
      state.attempts.push(other);
      expect(() => acceptAttempt(state, a.id, proof)).toThrow();
    });
  }));

test("oversized state writes retain the last readable durable record", async () =>
  sandbox(async (s) => {
    await s.transaction(async (state, save) => {
      state.batch_id = "safe";
      save();
    });
    await expect(
      s.transaction(async (state, save) => {
        state.classification_runs.push({
          id: "too-large",
          status: "intent",
          request: "x".repeat(16_000_000),
        });
        save();
      }),
    ).rejects.toThrow("16 MB");
    expect(s.read().batch_id).toBe("safe");
    expect(s.read().classification_runs).toHaveLength(0);
  }));
