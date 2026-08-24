import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors";
import { clampLimit, decodeCursor, encodeCursor } from "../src/paginate";

describe("cursors", () => {
  it("round-trips a keyset position", () => {
    const cursor = encodeCursor({ occurred_on: "2026-08-20", id: "enc_7" });
    expect(decodeCursor(cursor)).toEqual({ occurred_on: "2026-08-20", id: "enc_7" });
  });

  it("decodes an absent cursor to null rather than throwing", () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it("rejects a malformed cursor as invalid_input", () => {
    try {
      decodeCursor("not-a-cursor");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid_input");
    }
  });
});

describe("clampLimit", () => {
  it("returns the default when nothing is asked for", () => {
    expect(clampLimit(undefined, 20, 50)).toBe(20);
  });

  it("returns the requested value inside the range", () => {
    expect(clampLimit(35, 20, 50)).toBe(35);
  });

  it("throws limit_exceeded above the maximum rather than silently clamping", () => {
    // Silently returning 50 for a requested 500 tells the agent it got
    // everything. The whole point of the closed error set is that a refusal
    // carries a code the agent can act on.
    try {
      clampLimit(500, 20, 50);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("limit_exceeded");
    }
  });

  it("rejects a non-integer limit", () => {
    try {
      clampLimit(2.5, 20, 50);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid_input");
    }
  });
});
