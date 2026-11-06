import { createHash, createHmac, randomUUID } from "node:crypto";

const UINT64_RANGE = 2 ** 32 * 2 ** 32;

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function hmacFraction(secret: string, parts: readonly string[]): number {
  const digest = createHmac("sha256", secret).update(parts.map((part) => `${part.length}:${part}`).join("|")).digest();
  const high = digest.readUInt32BE(0);
  const low = digest.readUInt32BE(4);
  return (high * 2 ** 32 + low) / UINT64_RANGE;
}

export function eventId(): string {
  return randomUUID();
}

export function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
