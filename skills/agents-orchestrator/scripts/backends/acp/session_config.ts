import * as acp from "@agentclientprotocol/sdk";

import { RuntimeError, type RuntimeRecord } from "../../runtime_types.ts";

export const MODE_PREFERENCES: Readonly<Record<string, readonly string[]>> = {
  allow_in_workspace: ["agent", "default", "auto"],
  allow_all: ["agent-full-access", "bypassPermissions", "full-access"],
  deny_all: ["dontAsk", "read-only", "plan"],
};

function values(option: RuntimeRecord): string[] {
  const result: string[] = [];
  for (const entry of Array.isArray(option.options) ? option.options : []) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as RuntimeRecord;
    if (Array.isArray(item.options)) {
      for (const nested of item.options) {
        if (nested !== null && typeof nested === "object" && !Array.isArray(nested) && typeof (nested as RuntimeRecord).value === "string") {
          result.push((nested as RuntimeRecord).value);
        }
      }
    } else if (typeof item.value === "string") result.push(item.value);
  }
  return result;
}

function find(options: unknown, category: string): RuntimeRecord | null {
  for (const candidate of Array.isArray(options) ? options : []) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as RuntimeRecord;
    if (item.category === category || item.id === category) return item;
  }
  return null;
}

async function setOption(client: acp.ClientContext, sessionId: string, option: RuntimeRecord, value: string): Promise<string> {
  if (option.currentValue !== value) {
    await client.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId: String(option.id),
      value,
    });
  }
  return value;
}

export async function configureSession(
  client: acp.ClientContext,
  sessionId: string,
  options: unknown,
  settings: { model?: string | null; permissionPolicy: string },
): Promise<Record<string, string>> {
  const configured: Record<string, string> = {};
  const modelOption = find(options, "model");
  if (modelOption) {
    const offered = values(modelOption);
    if (settings.model && settings.model !== "default" && !offered.includes(settings.model)) {
      throw new RuntimeError(`ACP model is not offered by Agent: ${settings.model}`);
    }
    const target = settings.model && offered.includes(settings.model)
      ? settings.model : typeof modelOption.currentValue === "string" ? modelOption.currentValue : null;
    if (target) configured.model = await setOption(client, sessionId, modelOption, target);
  } else if (settings.model && settings.model !== "default") {
    throw new RuntimeError(`ACP Agent did not offer model configuration for ${settings.model}`);
  }
  if (settings.permissionPolicy === "prompt") throw new RuntimeError("ACP permission policy 'prompt' has no headless UI");
  const modeOption = find(options, "mode");
  if (modeOption) {
    const offered = values(modeOption);
    const preferences = MODE_PREFERENCES[settings.permissionPolicy];
    if (!preferences) throw new RuntimeError(`unknown ACP permission policy: ${settings.permissionPolicy}`);
    const target = preferences.find((value) => offered.includes(value));
    if (!target && new Set(["allow_in_workspace", "deny_all"]).has(settings.permissionPolicy)) {
      throw new RuntimeError(`ACP Agent did not offer a safe mode for permission policy ${settings.permissionPolicy}`);
    }
    if (target) configured.mode = await setOption(client, sessionId, modeOption, target);
  }
  return configured;
}
