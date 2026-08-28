import { describe, expect, it } from "vitest";
import { ToolError } from "../src/errors";
import { validateInput } from "../src/validate";
import { enumOf, id, int, nullableStr, obj, str, strArray } from "../src/tools/schema";

const schema = obj(
  {
    person_id: id("p", "Person"),
    query: str("Search text."),
    limit: int("Page size."),
    scope: enumOf(["people", "roster"], "Which records."),
    notes: nullableStr("Standing notes."),
    tags: strArray("Tag names."),
  },
  ["person_id"]
);

const reason = (fn: () => void) => {
  try {
    fn();
    throw new Error("expected validateInput to throw and it did not");
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    expect(e.code).toBe("invalid_input");
    return e.message;
  }
};

describe("validateInput", () => {
  it("accepts a call with only the required property", () => {
    expect(() => validateInput("t", schema, { person_id: "p_1" })).not.toThrow();
  });

  it("accepts every declared property at its declared type", () => {
    expect(() =>
      validateInput("t", schema, {
        person_id: "p_1",
        query: "ada",
        limit: 10,
        scope: "roster",
        notes: null,
        tags: ["speaker"],
      })
    ).not.toThrow();
  });

  it("names the unknown property and what was expected", () => {
    const msg = reason(() => validateInput("t", schema, { person_id: "p_1", cursor: "x" }));
    expect(msg).toContain("cursor");
    expect(msg).toContain("person_id");
  });

  // A `__proto__` key must become an own property of `cleaned`, not set its
  // prototype. Plain assignment (`cleaned[key] = value`) does the latter,
  // which would hide the key from `additionalProperties: false` entirely -
  // this call would not throw at all if that regressed.
  it("refuses a caller-sent __proto__ as an unknown argument", () => {
    const input = JSON.parse('{"person_id": "p_1", "__proto__": {"polluted": true}}');
    const msg = reason(() => validateInput("t", schema, input));
    expect(msg).toContain("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("refuses a missing required property", () => {
    expect(reason(() => validateInput("t", schema, {}))).toContain("person_id");
  });

  it("refuses the wrong type", () => {
    expect(reason(() => validateInput("t", schema, { person_id: 1 }))).toContain("person_id");
  });

  it("refuses a string where an integer is declared", () => {
    reason(() => validateInput("t", schema, { person_id: "p_1", limit: "10" }));
  });

  it("refuses a fractional value where an integer is declared", () => {
    reason(() => validateInput("t", schema, { person_id: "p_1", limit: 1.5 }));
  });

  it("refuses a value outside an enum", () => {
    expect(reason(() => validateInput("t", schema, { person_id: "p_1", scope: "all" }))).toContain(
      "roster"
    );
  });

  it("refuses a non-array where an array is declared", () => {
    reason(() => validateInput("t", schema, { person_id: "p_1", tags: "speaker" }));
  });

  it("refuses an array whose items are the wrong type", () => {
    reason(() => validateInput("t", schema, { person_id: "p_1", tags: [1] }));
  });

  it("accepts null only where null is declared", () => {
    expect(() => validateInput("t", schema, { person_id: "p_1", notes: null })).not.toThrow();
    reason(() => validateInput("t", schema, { person_id: "p_1", query: null }));
  });

  // THE ONE THAT PROTECTS THE ERROR DESIGN. `id()` puts a ^p_ pattern in the
  // schema, and src/ids.ts reports a wrong-kind id as invalid_id. If this
  // validator enforced the pattern, that id would become invalid_input and
  // tests/mcp.test.ts's "maps an id of the wrong kind to invalid_id, not to
  // a crash" would break along with the distinction it guards.
  it("does not enforce id patterns, leaving them to assertId", () => {
    expect(() => validateInput("t", schema, { person_id: "re_1" })).not.toThrow();
  });

  it("still refuses an id that is not a string at all", () => {
    reason(() => validateInput("t", schema, { person_id: 7 }));
  });

  // undefined is JSON's absence. Refusing it would reject
  // {person_id: "p_1", query: undefined}, which serializes to a call with no
  // query at all.
  it("treats an explicitly undefined property as absent", () => {
    expect(() => validateInput("t", schema, { person_id: "p_1", query: undefined })).not.toThrow();
  });

  it("refuses input that is not an object", () => {
    reason(() => validateInput("t", schema, "nope"));
    reason(() => validateInput("t", schema, [1, 2]));
    reason(() => validateInput("t", schema, null));
  });

  it("reports every problem at once rather than the first", () => {
    const msg = reason(() => validateInput("t", schema, { a: 1, b: 2 }));
    expect(msg).toContain("a");
    expect(msg).toContain("b");
    expect(msg).toContain("person_id");
  });

  it("never echoes a value into the message", () => {
    const msg = reason(() =>
      validateInput("t", schema, { person_id: "p_1", query: 42, secret_note: "Ada's address" })
    );
    expect(msg).not.toContain("Ada");
  });

  it("names the tool so a refusal is greppable", () => {
    expect(reason(() => validateInput("get_person", schema, {}))).toContain("get_person");
  });
});

// Guards the seam between this project's schema helpers and the library.
// A helper added later that emits a keyword the stripper does not know about
// would otherwise be enforced silently, including a new pattern.
//
// Walks nested schema objects (an array's `items`, an object's nested
// `properties`) rather than only the top level. A `pattern` (or any other
// unsupported keyword) added inside `items` would otherwise be enforced
// silently, unchecked by `withoutPatterns`, which only strips top-level
// patterns - exactly the failure this guard exists to prevent. No nested
// pattern exists today; the point is that adding one later cannot be silent.
describe("every registered schema is safe to hand to the validator", () => {
  const SUPPORTED = new Set([
    "type", "description", "enum", "pattern", "items", "properties", "required",
    "additionalProperties",
  ]);

  function walk(spec: unknown, toolName: string, path: string): void {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return;
    const record = spec as Record<string, unknown>;
    for (const keyword of Object.keys(record)) {
      expect(SUPPORTED.has(keyword), `${toolName} uses ${keyword} at ${path}`).toBe(true);
    }
    if (record.items !== undefined) walk(record.items, toolName, `${path}/items`);
    if (record.properties !== null && typeof record.properties === "object") {
      for (const [key, child] of Object.entries(record.properties as Record<string, unknown>)) {
        walk(child, toolName, `${path}/properties/${key}`);
      }
    }
  }

  it("declares no keyword outside the supported set, at any depth", async () => {
    const { TOOLS } = await import("../src/tools/index");
    for (const tool of Object.values(TOOLS)) {
      for (const [key, spec] of Object.entries(tool.inputSchema.properties)) {
        walk(spec, tool.name, key);
      }
    }
  });
});
