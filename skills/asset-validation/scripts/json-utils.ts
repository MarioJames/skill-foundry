/** Match json.dumps(..., ensure_ascii=False) for ACC's JSON-compatible values. */
export function jsonDumps(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    if (Object.is(value, -0)) return "-0.0";
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => jsonDumps(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    const fields = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}: ${jsonDumps(item)}`);
    return `{${fields.join(", ")}}`;
  }
  throw new TypeError(`value is not JSON serializable: ${String(value)}`);
}
