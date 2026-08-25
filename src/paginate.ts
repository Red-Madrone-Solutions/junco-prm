import { ToolError } from "./errors";

/**
 * One cursor convention for every read tool. The cursor is opaque to the
 * caller by contract - it is base64url over JSON, and nothing outside this
 * module may parse it - so the keyset it encodes can change without changing
 * the tool surface.
 */
export function encodeCursor(value: Record<string, string | number>): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeCursor(
  cursor: string | undefined
): Record<string, string | number> | null {
  if (cursor === undefined || cursor === "") return null;
  try {
    const base64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, string | number>;
  } catch {
    throw new ToolError(
      "invalid_input",
      "cursor is not a token this server issued",
      "call the same tool again without a cursor to start from the first page"
    );
  }
}

/**
 * Above the maximum this throws rather than clamping. Silently returning 50 for
 * a requested 500 tells the agent it received everything, which is the failure
 * a cursor convention exists to prevent.
 */
export function clampLimit(requested: unknown, def: number, max: number): number {
  if (requested === undefined || requested === null) return def;
  if (typeof requested !== "number" || !Number.isInteger(requested)) {
    throw new ToolError("invalid_input", "limit must be an integer");
  }
  if (requested < 1) throw new ToolError("invalid_input", "limit must be at least 1");
  if (requested > max) {
    throw new ToolError(
      "limit_exceeded",
      `limit must be ${max} or fewer`,
      `call again with limit: ${max} and page with the returned cursor`
    );
  }
  return requested;
}
