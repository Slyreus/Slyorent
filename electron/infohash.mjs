const V1_HEX_PATTERN = /^[a-f0-9]{40}$/u;
const V2_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const V2_MULTIHASH_PATTERN = /^1220([a-f0-9]{64})$/u;

export function canonicalizeInfohash(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  const normalized = value.toLowerCase();
  if (V1_HEX_PATTERN.test(normalized) || V2_HEX_PATTERN.test(normalized)) return normalized;
  return V2_MULTIHASH_PATTERN.exec(normalized)?.[1] ?? null;
}

export function normalizeInfohash(value, message = "Infohash invalide.") {
  const normalized = canonicalizeInfohash(value);
  if (!normalized) throw new TypeError(message);
  return normalized;
}

export function isCanonicalInfohash(value) {
  return typeof value === "string"
    && (V1_HEX_PATTERN.test(value) || V2_HEX_PATTERN.test(value));
}
