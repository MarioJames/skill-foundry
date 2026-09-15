import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL_DIR = join(import.meta.dir, "..");

describe("runtime and external validator documentation", () => {
  test("keeps ACC on Bun while retaining the authoritative external Python fallback", () => {
    const skill = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
    const review = readFileSync(join(SKILL_DIR, "references", "review-and-fix.md"), "utf8");
    expect(skill).toContain("scripts/acc.ts");
    expect(review).toContain("not imported by ACC, shipped in this skill, or a runtime dependency");
    expect(review).toContain("quick_validate.ts");
    expect(review).toContain("quick_validate.py");
    expect(review).toContain("external skill-creator");
    expect(review).toContain('python3 "$VALIDATOR_PY" <skill_dir>');
    expect(review).toContain("Do not inspect, grep, or read an external validator");
    expect(review).toContain("ModuleNotFoundError: No module named 'yaml'");
    expect(review).toContain('uv run --no-project --with pyyaml python3 "$VALIDATOR_PY"');
  });

  test("separates host selection probes from explicit staged-skill execution", () => {
    const acceptance = readFileSync(join(SKILL_DIR, "references", "acceptance.md"), "utf8");
    const strategy = readFileSync(
      join(SKILL_DIR, "references", "asset-strategies", "skill.md"),
      "utf8",
    );
    expect(acceptance).toContain("namespaced slash command");
    expect(strategy).toContain("Separate host selection from functional execution");
    expect(strategy).toContain("exact staged slash token");
  });

  test("documents host-specific standalone skill staging and provenance", () => {
    const unattended = readFileSync(
      join(SKILL_DIR, "references", "unattended-execution.md"),
      "utf8",
    );
    const strategy = readFileSync(
      join(SKILL_DIR, "references", "asset-strategies", "skill.md"),
      "utf8",
    );
    expect(unattended).toContain("host-specific launch settings");
    expect(unattended).toContain("`.agents/skills/<name>`");
    expect(unattended).toContain("same-name global skill wins");
    expect(strategy).toContain("For Codex");
    expect(strategy).toContain("verify executed script/file paths");
  });

  test("documents the closed set of scheduling mode values", () => {
    const unattended = readFileSync(
      join(SKILL_DIR, "references", "unattended-execution.md"),
      "utf8",
    );
    expect(unattended).toContain("not free-form");
    expect(unattended).toContain("`stop-loss`, `collect-first`, or `hybrid`");
    expect(unattended).toContain("values such as `auto` are invalid");
  });

  test("documents the BSD cat portability trap used during review", () => {
    const review = readFileSync(join(SKILL_DIR, "references", "review-and-fix.md"), "utf8");
    expect(review).toContain("BSD `cat`");
    expect(review).toContain("no GNU `cat -A`");
    expect(review).toContain("sed -n 'l'");
  });

  test("keeps ACC gate discovery on the documented CLI contract and makes BSD sed line ranges numeric", () => {
    const review = readFileSync(join(SKILL_DIR, "references", "review-and-fix.md"), "utf8");
    const unattended = readFileSync(
      join(SKILL_DIR, "references", "unattended-execution.md"),
      "utf8",
    );
    expect(unattended).toContain("Do not open, grep, or line-slice `scripts/catalog.ts`");
    expect(unattended).toContain("Invoke `acc finalize --verdict <PASS|FAIL|CONDITIONAL>` directly");
    expect(review).toContain("`rg -n` emits `line:text`, not a bare line number");
    expect(review).toContain("invalid command code");
    expect(review).toContain("cut -d: -f1");
    expect(review).toContain("grep -Eq '^[0-9]+$'");
  });

  test("documents the required asset scope for history reads", () => {
    const unattended = readFileSync(
      join(SKILL_DIR, "references", "unattended-execution.md"),
      "utf8",
    );
    expect(unattended).toContain("`acc history --asset <asset-name-or-id>`");
    expect(unattended).toContain("never invoke bare `acc history`");
  });

  test("keeps review-only path persistence out of root and scratch inside isolation", () => {
    const review = readFileSync(join(SKILL_DIR, "references", "review-and-fix.md"), "utf8");
    const unattended = readFileSync(
      join(SKILL_DIR, "references", "unattended-execution.md"),
      "utf8",
    );
    expect(review).toContain("no strategy `WORK` by default");
    expect(review).toContain("never write `\"$WORK/.acc-path\"`");
    expect(unattended).toContain("non-empty existing absolute directory");
    expect(unattended).toContain('mktemp -d "${ACCEPTANCE_TMPDIR:-${TMPDIR:-/tmp}}/<purpose>.XXXXXX"');
    expect(review).toContain('>"$SCRATCH/stdout" 2>"$SCRATCH/stderr"');
    expect(review).toContain("never redirect to an illustrative `/tmp-placeholder`");
  });

  test("documents ripgrep no-match without hiding real command errors", () => {
    const review = readFileSync(join(SKILL_DIR, "references", "review-and-fix.md"), "utf8");
    expect(review).toContain("Ripgrep and grep exit `0` for a match, `1` for no matches");
    expect(review).toContain("rg_rc=$?");
    expect(review).toContain("do not use blanket `|| true`");
  });
});
