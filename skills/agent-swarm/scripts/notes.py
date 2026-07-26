"""Shared-note validation and relevance selection."""

import state_store


CATEGORIES = {"decision", "pitfall", "note"}
SCOPES = {"global", "subtree", "task"}


def ancestors(task_id, con=None):
    result = []
    current = state_store.get_task(task_id, con)
    seen = set()
    while current and current["task_id"] not in seen:
        seen.add(current["task_id"])
        result.append(current["task_id"])
        parent_id = current.get("parent_task_id")
        current = state_store.get_task(parent_id, con) if parent_id else None
    return result


def select_notes(root_id, task_id, limit=12, con=None):
    chain = ancestors(task_id, con)
    chain_set = set(chain)
    relevant = []
    for note in state_store.list_notes(root_id, con=con):
        scope = note["scope"]
        owner = note.get("task_id")
        if scope == "global":
            applies = True
        elif scope == "task":
            applies = owner == task_id
        else:
            applies = owner in chain_set
        if not applies:
            continue
        if note["pinned"] and note["category"] == "decision":
            group = 0
        elif scope == "subtree":
            group = 1
        elif scope == "task":
            group = 2
        else:
            group = 3
        depth_rank = chain.index(owner) if owner in chain_set else len(chain)
        relevant.append((group, depth_rank, -note["created_at"], -note["note_id"], note))
    relevant.sort(key=lambda item: item[:4])
    return [item[4] for item in relevant[: max(0, min(int(limit), 12))]]


def write_note(con, context, payload):
    missing = [field for field in ("category", "content", "scope") if field not in payload]
    if missing:
        raise ValueError("write_note requires fields: %s" % ", ".join(missing))
    category = payload.get("category")
    scope = payload.get("scope")
    content = payload.get("content")
    if category not in CATEGORIES:
        raise ValueError("invalid note category")
    if scope not in SCOPES:
        raise ValueError("invalid note scope")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("note content is required")
    if len(content) > 500:
        raise ValueError("note content exceeds 500 characters")
    if "pinned" in payload and not isinstance(payload["pinned"], bool):
        raise ValueError("note pinned must be boolean")
    if "supersedes_id" in payload and (
        isinstance(payload["supersedes_id"], bool)
        or not isinstance(payload["supersedes_id"], (int, type(None)))
    ):
        raise ValueError("note supersedes_id must be an integer or null")
    count = con.execute(
        "SELECT COUNT(*) AS n FROM run_notes WHERE root_id = ?", (context["run"]["root_id"],)
    ).fetchone()["n"]
    if count >= 50:
        raise ValueError("run note budget exhausted")

    supersedes_id = payload.get("supersedes_id")
    if supersedes_id is not None:
        old = con.execute(
            "SELECT * FROM run_notes WHERE note_id = ? AND root_id = ?",
            (supersedes_id, context["run"]["root_id"]),
        ).fetchone()
        if old is None or old["category"] != "decision" or category != "decision":
            raise ValueError("supersedes_id must replace a decision in the same run")
        con.execute("UPDATE run_notes SET active = 0 WHERE note_id = ?", (supersedes_id,))

    cursor = con.execute(
        """INSERT INTO run_notes(
             root_id, task_id, agent_id, category, scope, content, pinned,
             supersedes_id, active, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)""",
        (
            context["run"]["root_id"],
            context["task"]["task_id"],
            context["agent"]["agent_id"],
            category,
            scope,
            content.strip(),
            1 if payload.get("pinned") else 0,
            supersedes_id,
            state_store.now(),
        ),
    )
    return cursor.lastrowid
