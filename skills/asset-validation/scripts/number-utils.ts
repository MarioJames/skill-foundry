export function parsePythonInteger(raw: string): number | null {
  const stripped = raw.trim();
  if (!/^[+-]?\d(?:_?\d)*$/.test(stripped)) return null;
  const parsed = Number(stripped.replaceAll("_", ""));
  return Number.isInteger(parsed) ? parsed : null;
}

export interface ParsedFloat {
  ok: boolean;
  value: number;
}

export function parsePythonFloat(raw: string): ParsedFloat {
  const stripped = raw.trim();
  if (/^[+-]?(?:inf(?:inity)?|nan)$/i.test(stripped)) {
    const normalized = stripped.toLowerCase();
    if (normalized.includes("nan")) return { ok: true, value: Number.NaN };
    return { ok: true, value: normalized.startsWith("-") ? -Infinity : Infinity };
  }
  const decimal = "(?:\\d(?:_?\\d)*)";
  const pattern = new RegExp(
    `^[+-]?(?:(?:${decimal}(?:\\.${decimal}?)?)|(?:\\.${decimal}))(?:[eE][+-]?${decimal})?$`,
  );
  if (!pattern.test(stripped)) return { ok: false, value: Number.NaN };
  const value = Number(stripped.replaceAll("_", ""));
  return { ok: !Number.isNaN(value), value };
}
