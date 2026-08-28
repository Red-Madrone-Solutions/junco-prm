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
  // tests/mcp.test.ts:140 would break along with the distinction it guards.
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
describe("every registered schema is safe to hand to the validator", () => {
  it("declares no keyword outside the supported set", async () => {
    const { TOOLS } = await import("../src/tools/index");
    const SUPPORTED = new Set([
      "type", "description", "enum", "pattern", "items", "properties", "required",
      "additionalProperties",
    ]);
    for (const tool of Object.values(TOOLS)) {
      for (const spec of Object.values(tool.inputSchema.properties)) {
        for (const keyword of Object.keys(spec as object)) {
          expect(SUPPORTED.has(keyword), `${tool.name} uses ${keyword}`).toBe(true);
        }
      }
    }
  });
});
