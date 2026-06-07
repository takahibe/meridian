// Egress redaction: scrubs known secret values from any text that leaves the
// process (Telegram messages, log lines, audit JSON). Defense-in-depth against
// a model or error accidentally relaying a secret outward.
//
// Catches the VERBATIM value only — a secret reformatted/split by a model can
// still slip through. For opaque tokens/keys that's effective in practice.

// Env var names whose values are secrets worth scrubbing.
const SECRET_KEY_PATTERN = /(PRIVATE_KEY|MNEMONIC|PASSPHRASE|SECRET|_TOKEN|API_KEY)/i;

let secrets = [];

/**
 * Snapshot current secret values from process.env. Call again after any runtime
 * env mutation (e.g. key rotation) so the redaction list stays current.
 */
export function refreshSecrets() {
  secrets = Object.keys(process.env)
    .filter((k) => SECRET_KEY_PATTERN.test(k))
    .map((k) => ({ name: k, value: process.env[k] }))
    .filter((s) => s.value && s.value.length >= 8)
    // Longest first so a secret that is a substring of another is fully masked.
    .sort((a, b) => b.value.length - a.value.length);
}

// Snapshot at import (dotenv/config runs first in index.js, so env is populated).
refreshSecrets();

/**
 * Replace every occurrence of a known secret value with [REDACTED:NAME].
 * Safe on any input; non-strings are returned unchanged.
 */
export function redact(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const { name, value } of secrets) {
    if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
  }
  return out;
}
