import { join } from "node:path";

import * as db from "./db.ts";
import { LookupError, ValidationError } from "./errors.ts";
import * as observe from "./observe.ts";
import * as rounds from "./rounds.ts";

export function cleanupRound(
  connection: db.Connection,
  roundId: string,
  options: { sandbox?: string | null } = {},
): Record<string, unknown> {
  const row = rounds.getCleanupTarget(connection, roundId);
  if (!row) throw new LookupError(`round not found: ${roundId}`);
  const sandbox = options.sandbox || row.sandbox_path;
  if (!sandbox) throw new ValidationError("cleanup requires --sandbox or --round");
  const session = observe.sessionName(row.round_tag);
  const sessionKilled = observe.killSession(session);
  const nestedSessions = cleanupNestedSessions(sandbox);
  let pluginCleanup: Record<string, unknown> | null = null;
  if (["plugin", "skill", "agent"].includes(row.asset_type)) {
    pluginCleanup = observe.cleanupPluginInstall(sandbox);
  }
  const result = observe.cleanup(sandbox);
  Object.assign(result, { session, session_killed: sessionKilled });
  if (nestedSessions.length) result.nested_sessions = nestedSessions;
  if (pluginCleanup !== null) result.plugin_cleanup = pluginCleanup;
  return result;
}

function cleanupNestedSessions(sandbox: string): Array<Record<string, unknown>> {
  const stateDatabase = join(sandbox, ".aut-acceptance", "state.sqlite3");
  const cleaned: Array<Record<string, unknown>> = [];
  for (const target of db.roundCleanupTargetsFrom(stateDatabase)) {
    if (!target.round_tag) continue;
    const session = observe.sessionName(target.round_tag);
    cleaned.push({ session, killed: observe.killSession(session) });
  }
  return cleaned;
}
