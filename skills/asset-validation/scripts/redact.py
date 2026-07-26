import re

SECRET_KEYS = (
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "AUTH_TOKEN",
    "API_KEY",
    "AGENT_SWARM_ACTOR_TOKEN",
    "AGENT_SWARM_TOKEN",
    "actor_token",
    "actorToken",
)

# High-confidence bare token shapes that can leak without a KEY= prefix.
_TOKEN_PATTERNS = (
    re.compile(r"sk-ant-[A-Za-z0-9_-]{8,}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(
        r"(?<![A-Za-z0-9_-])as_[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])"
    ),
)


def redact_secrets(text: str) -> str:
    out = text
    for key in SECRET_KEYS:
        out = re.sub(
            rf'("{re.escape(key)}"\s*:\s*")[^"]+',
            rf'\1<redacted>',
            out,
        )
        out = re.sub(
            rf"({re.escape(key)}=)[^\s]+",
            rf"\1<redacted>",
            out,
        )
    for pattern in _TOKEN_PATTERNS:
        out = pattern.sub("<redacted>", out)
    return out
