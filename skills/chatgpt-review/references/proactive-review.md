# Proactive Pro review

Judge the cost of a wrong decision, its reach, and the strength of available evidence. Topic keywords alone do not justify a remote review. Use the user's designated Pro model and existing account/project authorization; do not silently substitute a model or expand the material allowed to leave the machine.

## Trigger at decision points

Initiate by default when:

- Making consequential architecture or technology choices: boundaries, storage, cross-service contracts or critical dependencies whose reversal would be costly.
- A substantial solution has a concrete recommended design and is about to be presented for final confirmation or implemented. Cross-check requirements, alternatives, failure modes and acceptance criteria before calling it final.
- A high-risk implementation is about to proceed: authorization, tenant isolation, data migration, concurrency consistency or irreversible effects. Review the relevant mechanism and recovery path, not merely the feature name.

Initiate when there is concrete evidence of a problem or uncertainty:

- A decision depends on unverified library behavior, runtime semantics or performance assumptions that could change the choice.
- Debugging stalls after attempted fixes, or the proposed root cause contradicts observed behavior. Send the failed hypotheses and observations so the reviewer can challenge the starting assumptions.
- Implementation uncovers a constraint that materially changes the accepted design, boundaries or guarantees.
- A consequential feature is ready for acceptance but independent scrutiny of coverage, failure paths or release evidence could change the go/no-go decision.

Do not automatically review routine copy/style changes, small features following an established pattern, or ordinary low-risk local reviews. Explicit requests still apply. Follow an explicit local-only/no-external instruction even at a high-risk gate. Missing product goals require user input; model review cannot decide those goals on the user's behalf.

## Send a reviewable decision

Prepare a concrete draft before requesting review. Include the goal and constraints, relevant code/revision, alternatives and recommendation, verified evidence, assumptions and unresolved questions. Use only authorized, task-relevant material and omit secrets. For acceptance, supply actual test evidence and its limits; the remote reviewer must not claim to have run the local tests.

Ask for failure-causing assumptions, concrete counterexamples, simpler established alternatives, and a distinction between verified defects and hypotheses. Request decision-blocking issues separately from optional improvements and ask what experiment would resolve a disagreement. Avoid a generic request for approval.

Use [conversation.md](conversation.md) to reuse the requirement session and verify the project/model, then [commands.md](commands.md) to bind the submitted turn and its background watcher. Briefly tell the user which decision warrants review. Continue independent work while the watcher checks every 60 seconds.

## Close the gate without a review loop

Record the decision under review and the input revision/evidence in the existing private requirement record. Before sending, reuse an applicable completed review or continue waiting for its active run. A later workflow stage alone is not a new review: normally send once per decision version, with follow-ups only for material changes or an unresolved blocker. Minor wording changes and optional suggestions do not start another mutual-review cycle.

When review is a prerequisite for final confirmation, implementation or release, wait for its complete response and resolve decision-blocking findings against local evidence before crossing that gate. The controlling Agent owns the conclusion; agreement between models is not proof. Record accepted/rejected findings with reasons and evidence limits. Once blockers are resolved, proceed without seeking repeated model approval.

If the model, login or watcher is unavailable, report the review as pending/blocked and continue independent work. Do not present an unreviewed gate as passed, silently fall back to another model, or resend a timed-out prompt. The user can explicitly waive the pending review; this does not waive separate testing or action-authorization requirements.
