# Scheduling engine (dynamic, principle-driven)

Three modes (the `--mode` flag of `acc start`):

- **stop-loss** (及时止损): a defect that blocks the whole run → stop now, fix, restart a fresh round. Quickly cuts defects that poison scheduling.
- **collect-first** (收集优先): logic validation → fix inline just enough to keep going, collect as many error scenarios as possible, batch-fix at round end, then restart.
- **hybrid** (混合调度): within one round, choose per defect — stop-loss for blocking defects; for a non-blocking script error, hot-fix the script + update the skill, and the asset-under-test re-judges from the return value on its next call while you keep collecting.

Criterion: **stop where it yields the most benefit for the current task.** Do not hard-wire "many scripts ⇒ stop-loss".

Every round must output three things:
1. recommended mode + a solid reason;
2. this round's acceptance criteria (GREEN/AMBER/RED + hard-fail items);
3. once criteria are met, whether to switch mode / start the next round + its purpose and strategy.
