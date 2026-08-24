import { ToolError } from "./errors";

export type IdKind = "p" | "re" | "enc" | "fu" | "rs" | "ir" | "ps" | "pc" | "pl" | "tg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newId(kind: IdKind): string {
  return `${kind}_${crypto.randomUUID()}`;
}

export function assertId(kind: IdKind, value: unknown): string {
  if (typeof value !== "string") {
    throw new ToolError("invalid_id", `expected a ${kind}_ id, got ${typeof value}`);
  }
  const marker = `${kind}_`;
  if (!value.startsWith(marker)) {
    throw new ToolError("invalid_id", `expected a ${kind}_ id, got "${value}"`);
  }
  if (!UUID.test(value.slice(marker.length))) {
    throw new ToolError("invalid_id", `expected a ${kind}_ id, got "${value}"`);
  }
  return value;
}
