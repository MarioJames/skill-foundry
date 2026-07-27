import * as acp from "@agentclientprotocol/sdk";

import type { PermissionDecision } from "./permissions.ts";

export type PermissionHandler = (
  request: acp.RequestPermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>;
export type SessionUpdateHandler = (
  notification: acp.SessionNotification,
) => void | Promise<void>;

/** Build the narrow headless Client surface used by detached Workers. */
export function createAcpClient(
  permissionHandler: PermissionHandler,
  sessionUpdateHandler?: SessionUpdateHandler,
): acp.ClientApp {
  const app = acp.client({ name: "agents-orchestrator" })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      const decision = await permissionHandler(params);
      return decision.selectedOptionId === null
        ? { outcome: { outcome: "cancelled" as const } }
        : { outcome: { outcome: "selected" as const, optionId: decision.selectedOptionId } };
    });
  if (sessionUpdateHandler) {
    app.onNotification(acp.methods.client.session.update, ({ params }) => sessionUpdateHandler(params));
  }
  return app;
}

export function connectAgent(
  app: acp.ClientApp,
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
): acp.ClientConnection {
  return app.connect(acp.ndJsonStream(output, input));
}
