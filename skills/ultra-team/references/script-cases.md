# Ultra Orchestrator Script Cases

This file holds command cases only.
For protocol rules, see `recursion-protocol.md`.

## Root init

```bash
python3 <skill>/scripts/agent_orchestrator.py init \
  --task "<the task after the user's ultra team trigger phrase>" \
  --cwd "$(pwd)"
```

On success, save the returned `root_id`.
When root dispatches children directly, `--parent-id` MUST be this `root_id`; do NOT pass the literal `root`.

If the current directory is the resume site of an old run, and that old run is already in a `done` or
`failed` terminal state, you may explicitly allow creating a new root run in the same directory:

```bash
python3 <skill>/scripts/agent_orchestrator.py init \
  --task "<task that resumes the existing artifacts in the current directory>" \
  --cwd "$(pwd)" \
  --allow-terminal-cwd
```

This flag is only allowed when all existing runs are terminal; it still refuses while a `running` run
remains in the same directory.

## Implement dispatch

```bash
python3 <skill>/scripts/agent_orchestrator.py dispatch \
  --root-id <root_id> \
  --parent-id <agent_id> \
  --round 1 \
  --kind implement \
  --task "implement non-overlapping task A" \
  --task "implement non-overlapping task B"
```

Multi-line tasks or tasks containing backticks (**preferred** — avoids temp files, stored in DB via `agents.prompt`):

```bash
python3 <skill>/scripts/agent_orchestrator.py dispatch \
  --root-id <root_id> \
  --parent-id <agent_id> \
  --round 1 \
  --kind implement \
  --task-stdin <<'EOF'
Implement foundation: create `src/lib/design-tokens.ts`, `src/lib/types.ts`, and shared components.
EOF
```

`--task-stdin` reads exactly one child task from stdin. It is not a separator-aware batch format.
If you have multiple multi-line tasks, run one `dispatch` command per task before a single
`await-round`; do not concatenate separate task bodies into one heredoc.

```bash
python3 <skill>/scripts/agent_orchestrator.py dispatch \
  --root-id <root_id> \
  --parent-id <agent_id> \
  --round 1 \
  --kind implement \
  --task-stdin <<'EOF'
Implement non-overlapping multi-line task A.
EOF

python3 <skill>/scripts/agent_orchestrator.py dispatch \
  --root-id <root_id> \
  --parent-id <agent_id> \
  --round 1 \
  --kind implement \
  --task-stdin <<'EOF'
Implement non-overlapping multi-line task B.
EOF
```

It can be combined with `--task` in a single dispatch only when the stdin body itself is one task.

Choose background config by project subagent and task complexity:

```bash
python3 <skill>/scripts/agent_orchestrator.py dispatch \
  --root-id <root_id> \
  --parent-id <agent_id> \
  --round 1 \
  --kind implement \
  --agent code-writer \
  --model sonnet \
  --task "implement task A"
```

Pick `--agent` from the current project's `.claude/agents/`.
One `--agent` applies to all tasks; multiple `--agent` MUST map one-to-one to the tasks.
Omitting `--model` uses Claude's default model; haiku for simple tasks, opus for complex ones.

## Await the same round

```bash
python3 <skill>/scripts/agent_orchestrator.py await-round \
  --root-id <root_id> \
  --parent-id <agent_id> \
  --round 1
```

If it returns `listen_window_expired:true` or `still_waiting:true`:

- Do NOT dispatch review/fix.
- Read `required_next_action` and `next_commands`.
- `continue_await_round`: run the corresponding `command` to keep waiting on the same round.
- `recover_idle_agent`: run the corresponding `recover-idle-agent` command; it verifies the
  idle/working child, then via a temporary `tmux` session runs `claude attach <job_id>`, sends
  `continue`, detaches with `C-z`, then continues `continue_await_round` from the returned `next_commands`.
  An automatic candidate MUST satisfy both: Claude agent view is `status=idle` / `state=working`,
  AND the transcript has a recovery signal — `away_summary`, an empty `end_turn`, or multiple valid run events.
  Do NOT auto-recover just because it is `idle/working`, since a newly queued or scheduling background
  job may look the same.
- Only after you have manually attached and confirmed the background job is waiting for input may you run
  `recover-idle-agent --force`; that mode skips the transcript recovery signal but still verifies the job
  is visible in `claude agents` and `idle/working`.
- If the command was auto-backgrounded by Claude, first read the same background output file.

## Review

```bash
python3 <skill>/scripts/agent_orchestrator.py dispatch \
  --root-id <root_id> \
  --parent-id <agent_id> \
  --round 2 \
  --kind review \
  --task "check code, build, tests, and browser results against this level's success bar"
```

The review node only inspects; it does not modify business files and does not dispatch children.
Its return should contain verdict/issues/fix_scopes.

## Failed child recovery

When the `await-round` summary contains a failed child:

1. First dispatch `kind=review` to determine the nature of the failure.
2. If review judges it completed but failed to report, you may continue or enter the closeout gate.
3. If a fix is needed, dispatch `kind=fix` leaves per `fix_scopes`.
4. After the fix or re-dispatched implement completes, dispatch review again.

## Fix

```bash
python3 <skill>/scripts/agent_orchestrator.py dispatch \
  --root-id <root_id> \
  --parent-id <agent_id> \
  --round 3 \
  --kind fix \
  --task "fix only the files or modules the reviewer specified"
```

The fixer is a leaf.
No `dispatch`, `claude --bg`, `claude agents`, or Workflow.

## Finish

```bash
python3 <skill>/scripts/agent_orchestrator.py finish \
  --agent-id <agent_id> \
  --root-id <root_id> \
  --result "<result summary>" \
  --caveats "<unresolved items, optional>"
```

For a node that ever dispatched direct children, the last direct child MUST be a done review.
Otherwise `finish` refuses.

## Stop the whole tree

```bash
python3 <skill>/scripts/agent_orchestrator.py stop \
  --root-id <root_id>
```

After stopping, verify:

```bash
claude agents --json
```

The script calls `claude rm` on recorded visible Claude jobs to reap the agent view.
Confirm no `ut-*` background session for this run remains under the same cwd.
If stop outputs `terminal:true`, the current response MUST HARD STOP.

## Bootstrap round

For an empty directory, project scaffold, or when the user explicitly requires "keep all files in the
current directory / no git init / do not create `.git`":

1. Bootstrap first, on its own.
2. After bootstrap completes, dispatch tokens, types, components, mock, engine, pages, docs, or acceptance scripts.
3. Shared wiring is handled by the parent, or as a dedicated serial round.

Confirm the current CLI arguments before using create-next-app:

```bash
npx create-next-app@latest --help
```

For a current-directory command, prefer:

```bash
npx create-next-app@latest . \
  --ts \
  --app \
  --src-dir \
  --no-tailwind \
  --eslint \
  --disable-git \
  --use-npm \
  --yes
```

Do NOT use:

```bash
npm create-next-app@latest -- --typescript ... --dir .
```

In the current environment that form misparses `--typescript` as the project directory.

Bootstrap acceptance MUST confirm:

- `package.json` exists at the root.
- The project did not land in a `--typescript/` or other subdirectory.
- `find . -name .git -type d` returns nothing.

Any failed condition MUST clean up the failed artifacts and retry or report failure.
Do NOT dispatch subsequent rounds.
