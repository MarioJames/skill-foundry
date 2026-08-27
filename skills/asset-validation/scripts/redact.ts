export const SECRET_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AUTH_TOKEN",
  "API_KEY",
  "actor_token",
  "actorToken",
] as const;

const TOKEN_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9_-])as_[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g,
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSecrets(text: string): string {
  let output = text;
  for (const key of SECRET_KEYS) {
    const escaped = escapeRegExp(key);
    output = output.replace(
      new RegExp(`(\"${escaped}\"\\s*:\\s*\")[^\"]+`, "g"),
      "$1<redacted>",
    );
    output = output.replace(
      new RegExp(`(${escaped}=)[^\\s]+`, "g"),
      "$1<redacted>",
    );
  }
  for (const pattern of TOKEN_PATTERNS) {
    output = output.replace(pattern, "<redacted>");
  }
  return output;
}
