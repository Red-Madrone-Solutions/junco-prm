import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors";
import { assertId, newId } from "../src/ids";

describe("newId", () => {
  it("prefixes by kind", () => {
    expect(newId("p")).toMatch(/^p_[0-9a-f-]{36}$/);
    expect(newId("enc")).toMatch(/^enc_[0-9a-f-]{36}$/);
  });

  it("does not collide", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId("p")));
    expect(ids.size).toBe(500);
  });
});

describe("assertId", () => {
  it("returns an id of the right kind", () => {
    const id = newId("p");
    expect(assertId("p", id)).toBe(id);
  });

  it("rejects an id of the wrong kind", () => {
    const rosterEntry = newId("re");
    expect(() => assertId("p", rosterEntry)).toThrow(ToolError);
    try {
      assertId("p", rosterEntry);
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid_id");
      expect((e as ToolError).message).toContain("expected a p_ id");
    }
  });

  it("rejects a bare uuid with no prefix", () => {
    expect(() => assertId("p", "3f1c2b9e-0000-4000-8000-000000000000")).toThrow(ToolError);
  });

  it("rejects non-strings", () => {
    expect(() => assertId("p", 42)).toThrow(ToolError);
    expect(() => assertId("p", null)).toThrow(ToolError);
    expect(() => assertId("p", undefined)).toThrow(ToolError);
  });

  it("rejects a prefix that is a prefix of another kind", () => {
    // "p" must not accept a "ps_" id, and "ps" must not accept a "p_" id.
    expect(() => assertId("p", newId("ps"))).toThrow(ToolError);
    expect(() => assertId("ps", newId("p"))).toThrow(ToolError);
  });
});
