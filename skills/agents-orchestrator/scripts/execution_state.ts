import * as stateStore from "./state_store.ts";
import { canonicalJson, type RuntimeRecord, ValueError } from "./runtime_types.ts";

export const LIVE_ATTEMPT_STATES = new Set(["assigned", "evaluating", "active", "waiting", "stopping"]);

export function ownedLaunch(
  launchId: number,
  ownerNonce: string,
  connection?: stateStore.Connection,
): RuntimeRecord | null {
  return stateStore.fetchall(
    "SELECT * FROM launches WHERE launch_id=? AND owner_nonce=?",
    [launchId, ownerNonce],
    connection,
  )[0] ?? null;
}

export function ownershipIsLive(launchId: number, ownerNonce: string): boolean {
  return stateStore.transaction((connection) => connection.execute(
    `SELECT 1
       FROM launches l
       JOIN attempts a ON a.attempt_id=l.attempt_id
       JOIN tasks t ON t.task_id=a.task_id
       JOIN runs r ON r.root_id=t.root_id
      WHERE l.launch_id=? AND l.owner_nonce=?
        AND l.stop_requested_at IS NULL
        AND l.status IN ('starting','running')
        AND a.state IN ('assigned','evaluating','active','waiting')
        AND NOT EXISTS (
          SELECT 1 FROM attempts newer
           WHERE newer.task_id=a.task_id AND newer.attempt_no>a.attempt_no
        )
        AND NOT EXISTS (
          SELECT 1 FROM launches newer_launch
           WHERE newer_launch.attempt_id=l.attempt_id
             AND newer_launch.launch_no>l.launch_no
        )
        AND t.status IN ('assigned','active')
        AND r.status='running'`,
    [launchId, ownerNonce],
  ).fetchone() !== null, false);
}

export function registerControlEndpoint(launchId: number, ownerNonce: string, endpoint: string): boolean {
  return stateStore.transaction((connection) => connection.execute(
    `UPDATE launches
        SET control_endpoint=?, last_event_at=?
      WHERE launch_id=? AND owner_nonce=?
        AND stop_requested_at IS NULL AND status='starting'`,
    [endpoint, stateStore.now(), launchId, ownerNonce],
  ).rowcount === 1);
}

export function registerAgentProcess(launchId: number, ownerNonce: string, agentPid: number): boolean {
  return stateStore.transaction((connection) => {
    const cursor = connection.execute(
      `UPDATE launches
          SET agent_pid=?, last_event_at=?
        WHERE launch_id=? AND owner_nonce=?
          AND stop_requested_at IS NULL AND status='starting'`,
      [agentPid, stateStore.now(), launchId, ownerNonce],
    );
    if (cursor.rowcount === 1) {
      const record = stateStore.getLaunch(launchId, connection)!;
      stateStore.appendEvent(
        connection,
        record.root_id,
        "AcpWorkerStarted",
        { worker_pid: record.worker_pid, agent_pid: agentPid },
        record.task_id,
        record.attempt_id,
      );
    }
    return cursor.rowcount === 1;
  });
}

export interface ReadyOptions {
  externalSessionId: string;
  protocolVersion: number;
  capabilities: unknown;
  profileConfig: RuntimeRecord;
  cwd: string;
  mode?: string | null;
  model?: string | null;
}

export function markReady(launchId: number, ownerNonce: string, options: ReadyOptions): boolean {
  if (!options.externalSessionId) throw new ValueError("external_session_id is required");
  return stateStore.transaction((connection) => {
    const launch = stateStore.getLaunch(launchId, connection);
    if (launch === null) return false;
    const live = connection.execute(
      `SELECT 1
         FROM launches l
         JOIN attempts a ON a.attempt_id=l.attempt_id
         JOIN tasks t ON t.task_id=a.task_id
         JOIN runs r ON r.root_id=t.root_id
        WHERE l.launch_id=? AND l.owner_nonce=?
          AND l.stop_requested_at IS NULL AND l.status='starting'
          AND a.state='assigned' AND t.status='assigned' AND r.status='running'
          AND NOT EXISTS (
            SELECT 1 FROM attempts newer
             WHERE newer.task_id=a.task_id AND newer.attempt_no>a.attempt_no
          )
          AND NOT EXISTS (
            SELECT 1 FROM launches newer_launch
             WHERE newer_launch.attempt_id=l.attempt_id
               AND newer_launch.launch_no>l.launch_no
          )`,
      [launchId, ownerNonce],
    ).fetchone();
    if (live === null) return false;
    const timestamp = stateStore.now();
    const profileId = stateStore.ensureAgentProfile(connection, options.profileConfig);
    connection.execute(
      `INSERT INTO acp_sessions(
         launch_id, profile_id, external_session_id, cwd, protocol_version,
         capabilities_json, mode, model, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [
        launchId,
        profileId,
        options.externalSessionId,
        options.cwd,
        options.protocolVersion,
        canonicalJson(options.capabilities ?? {}),
        options.mode ?? null,
        options.model ?? null,
        timestamp,
      ],
    );
    connection.execute(
      `UPDATE launches
          SET status='running', prompt_state='in_flight', ready_at=?,
              last_worker_heartbeat_at=?, last_event_at=?
        WHERE launch_id=? AND owner_nonce=?`,
      [timestamp, timestamp, timestamp, launchId, ownerNonce],
    );
    connection.execute(
      `UPDATE attempts
          SET state='evaluating', started_at=COALESCE(started_at, ?), heartbeat_at=?
        WHERE attempt_id=? AND state='assigned'`,
      [timestamp, timestamp, launch.attempt_id],
    );
    connection.execute("UPDATE tasks SET status='active' WHERE task_id=? AND status='assigned'", [launch.task_id]);
    const session = stateStore.getSessionForLaunch(launchId, connection)!;
    stateStore.appendEvent(
      connection,
      launch.root_id,
      "AcpWorkerReady",
      { launch_id: launchId, agent_type: session.agent_type, external_session_id: options.externalSessionId },
      launch.task_id,
      launch.attempt_id,
      session.session_pk,
    );
    return true;
  });
}

export function heartbeat(launchId: number, ownerNonce: string): boolean {
  return stateStore.transaction((connection) => {
    const timestamp = stateStore.now();
    return connection.execute(
      `UPDATE launches
          SET last_worker_heartbeat_at=?, last_event_at=?
        WHERE launch_id=? AND owner_nonce=?
          AND status IN ('starting','running','stopping')`,
      [timestamp, timestamp, launchId, ownerNonce],
    ).rowcount === 1;
  });
}

export function recordTurnEnd(launchId: number, ownerNonce: string, reason: string, error = false): boolean {
  return stateStore.transaction((connection) => {
    const timestamp = stateStore.now();
    const cursor = connection.execute(
      `UPDATE launches
          SET status=?, prompt_state='ended', exit_reason=?, last_event_at=?
        WHERE launch_id=? AND owner_nonce=?
          AND status IN ('starting','running')`,
      [error ? "error" : "turn_ended", reason, timestamp, launchId, ownerNonce],
    );
    if (cursor.rowcount === 1) {
      const record = stateStore.getLaunch(launchId, connection)!;
      const session = stateStore.getSessionForLaunch(launchId, connection);
      stateStore.appendEvent(
        connection,
        record.root_id,
        "AgentExitedWithoutFinish",
        { reason, launch_id: launchId },
        record.task_id,
        record.attempt_id,
        session?.session_pk ?? null,
      );
    }
    return cursor.rowcount === 1;
  });
}

export function markClosed(launchId: number, ownerNonce: string, reason: string): boolean {
  return stateStore.transaction((connection) => {
    const timestamp = stateStore.now();
    const cursor = connection.execute(
      `UPDATE launches
          SET status='closed', prompt_state=CASE
                WHEN prompt_state='ended' THEN prompt_state ELSE 'cancelled' END,
              exit_reason=COALESCE(exit_reason, ?), closed_at=?, last_event_at=?
        WHERE launch_id=? AND owner_nonce=?`,
      [reason, timestamp, timestamp, launchId, ownerNonce],
    );
    if (cursor.rowcount === 1) {
      connection.execute(
        "UPDATE acp_sessions SET status='closed', closed_at=? WHERE launch_id=? AND status='active'",
        [timestamp, launchId],
      );
      const record = stateStore.getLaunch(launchId, connection)!;
      const session = stateStore.getSessionForLaunch(launchId, connection);
      stateStore.appendEvent(
        connection,
        record.root_id,
        "LaunchClosed",
        { launch_id: launchId, reason: record.exit_reason || reason },
        record.task_id,
        record.attempt_id,
        session?.session_pk ?? null,
      );
    }
    return cursor.rowcount === 1;
  });
}

export function markCleanupFailed(launchId: number, ownerNonce: string, reason: string): boolean {
  return stateStore.transaction((connection) => {
    const timestamp = stateStore.now();
    const cursor = connection.execute(
      `UPDATE launches
          SET status='error', prompt_state='cancelled', exit_reason=?, last_event_at=?
        WHERE launch_id=? AND owner_nonce=? AND status != 'closed'`,
      [reason, timestamp, launchId, ownerNonce],
    );
    if (cursor.rowcount === 1) {
      const record = stateStore.getLaunch(launchId, connection)!;
      stateStore.appendEvent(
        connection,
        record.root_id,
        "LaunchCleanupFailed",
        { launch_id: launchId, reason },
        record.task_id,
        record.attempt_id,
      );
    }
    return cursor.rowcount === 1;
  });
}

export function requestStop(launchId: number): boolean {
  return stateStore.transaction((connection) => {
    const timestamp = stateStore.now();
    return connection.execute(
      `UPDATE launches
          SET stop_requested_at=COALESCE(stop_requested_at, ?),
              status=CASE WHEN status IN ('starting','running') THEN 'stopping' ELSE status END,
              last_event_at=?
        WHERE launch_id=? AND status != 'closed'`,
      [timestamp, timestamp, launchId],
    ).rowcount === 1;
  });
}
