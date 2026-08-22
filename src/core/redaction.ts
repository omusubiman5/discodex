const SNOWFLAKE_PATTERN = /\b\d{17,20}\b/g;
const DISCORD_TOKEN_PATTERN = /\b(?:mfa\.[\w-]{20,}|[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,})\b/g;
const MEET_URL_PATTERN = /https:\/\/meet\.google\.com\/[a-z-]+/gi;
const SECRET_JSON_FIELD_PATTERN = /("(?:token|sessionId|session_id|endpoint|secret_key)"\s*:\s*)("(?:[^"\\]|\\.)*"|\[[^\]]*\])/gi;

export function redact(value: string): string {
  return value
    .replace(SECRET_JSON_FIELD_PATTERN, '$1"[REDACTED_SECRET]"')
    .replace(DISCORD_TOKEN_PATTERN, "[REDACTED_DISCORD_TOKEN]")
    .replace(SNOWFLAKE_PATTERN, "[REDACTED_ID]")
    .replace(MEET_URL_PATTERN, "[REDACTED_MEET_URL]");
}
