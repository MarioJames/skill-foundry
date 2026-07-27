export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type RuntimeRecord = Record<string, any>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function asRecord(value: unknown, label = "value"): Record<string, unknown> {
  if (!isRecord(value)) throw new ValueError(`${label} must be an object`);
  return value;
}

export function asString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new ValueError(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

export function asInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw new ValueError(`${label} must be an integer`);
  return parsed;
}

export function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ValueError(`${label} is invalid JSON`);
  }
}

export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (isRecord(item)) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, normalize(item[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export class ValueError extends Error {
  override name = "ValueError";
}

export class RuntimeError extends Error {
  override name = "RuntimeError";
}
