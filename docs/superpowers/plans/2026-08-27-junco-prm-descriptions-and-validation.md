# Junco PRM Descriptions and Argument Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make three tool descriptions match what their tools actually do, and make every tool refuse an argument it does not understand instead of silently ignoring it.

**Architecture:** No schema change and no new tools. Three descriptions are corrected in the registry. Then a hand-written validator walks each tool's existing `JsonSchema` and is called once, at the transport boundary in `src/mcp/server.ts`, before any handler runs. The validator is written rather than imported because Ajv compiles with `new Function`, which workerd forbids, and because the schema vocabulary actually in use is six keywords.

**Tech Stack:** TypeScript, Cloudflare Workers, `@modelcontextprotocol/sdk` 1.30.0, vitest 4.1.11 with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-08-27-junco-prm-read-surface-and-export-design.md` (phases P2 and P3)

**This is plan 2 of 3.** Plan 1 (`2026-08-27-junco-prm-backup-and-restore.md`) builds the backup and must be executed first: this plan changes refusal behaviour on a live instance that currently has no backup. Plan 3 covers the read surface and `update_followup`.

## Global Constraints

- **No em dashes or en dashes anywhere**, in code, comments, docs, or commit messages. Plain hyphens only.
- **No `console` calls anywhere in `src/`** except `src/log.ts`. A repository-wide test enforces this and it is a security property, not style.
- **The seven error codes are a closed set**: `invalid_input`, `invalid_id`, `not_found`, `conflict`, `confirmation_required`, `confirmation_invalid`, `limit_exceeded`. Adding an eighth is a spec change. Validation failures are `invalid_input`.
- **No personal data in error messages.** A refusal names parameters and types. It never echoes a value, because refusals are logged and logs are retained.
- **Plan 1 must have been executed**, with an archive taken and a restore drilled, before Task 7 deploys.
- **Take a Time Travel bookmark before the deploy in Task 7**, per `docs/BACKUP.md`.

---

## File Structure

**Created:**

- `src/validate.ts` - the validator. One exported function, walking `JsonSchema`. No dependencies.
- `tests/validate.test.ts` - unit tests for the walker.
- `tests/validation-boundary.test.ts` - proves refusal happens at the transport boundary and that no handler runs.
- `docs/SCHEMA-AUDIT.md` - the schema-versus-handler compatibility table for all 28 tools.

**Modified:**

- `src/tools/index.ts` - three descriptions, and whatever the audit finds.
- `src/mcp/server.ts` - one call, before `tool.run`.

---

### Task 1: Three descriptions that currently misdescribe real behaviour

Documentation only. No behaviour change, no schema change, no test change. This is separable from everything else in the plan and could ship alone.

**Files:**
- Modify: `src/tools/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Correct `promote_roster_entry`**

Find the `define("promote_roster_entry", ...)` call. Its description currently says only that it turns a staged roster row into a person, keeping provenance. Replace the description string with:

```typescript
      "Turn a staged roster row into a person you have actually engaged with, keeping its provenance. " +
        "If the roster row carries an email, it is stored as a person contact by this call. " +
        "That differs from create_person, whose email is used for duplicate detection only and is " +
        "not stored; calling add_contact afterwards with the same address is a no-op rather than a " +
        "duplicate, because contacts are unique per person, type, and normalized value.",
```

The behaviour is real and was confirmed by promoting a person whose roster row carried an address and reading the result back: the person already held it as a contact with no `add_contact` call made. The control case, a roster row with no email, returned empty contacts. The no-op claim is `src/tools/attributes.ts:45`, `ON CONFLICT (person_id, contact_type, normalized_value) DO NOTHING`.

- [ ] **Step 2: Document the `external_row_key` discriminator**

`src/normalize.ts:130` builds the key in three tiers. Nothing tells a caller this, so anyone joining Junco's provenance back to their own source data does a string comparison against `650` when the stored value is `k:650`, gets no match, and gets no explanation.

Find the `define("get_roster_entry", ...)` call and extend its description:

```typescript
      "Read one staged roster entry by its re_ id, including the fields as imported. " +
        "Provenance records carry external_row_key with a one-character tier prefix showing how " +
        "identity was derived: 'k:' plus the source's own row id when the import supplied one, " +
        "else 'e:' plus the normalized email, else 'h:' plus a hash of name and organization. " +
        "Stability follows the tier: a k: key is as stable as the source id, an e: key changes if " +
        "the email changes, and an h: key changes if the name or organization changes.",
```

- [ ] **Step 3: Say what `import_roster` returning counts costs the caller**

Find the `define("import_roster", ...)` call and append to its description:

```typescript
        " This returns counts, not entry ids, and there is no call that maps a source row to the " +
        "re_ id it created. Promotion therefore requires finding each entry separately. Plan a " +
        "roster import knowing that, rather than discovering it after the rows are staged.",
```

**Note for whoever executes plan 3:** that sentence is deleted there, when `external_row_key` becomes readable from the roster read tools. It is written now because it is true now, and it is flagged here so a later reader does not find a stale warning and trust it.

- [ ] **Step 4: Confirm nothing else changed**

Run: `npm test`
Expected: PASS, unchanged count. Descriptions are strings; if a test fails, a test was asserting on description text and that assertion needs to move to the new wording deliberately rather than by reflex.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/index.ts
git commit -m "docs: correct three tool descriptions that misdescribed real behaviour"
```

---

### Task 2: The schema-versus-handler audit

**Validation must not be switched on before this exists.** These schemas have never controlled runtime behaviour, so any place where a handler reads something the schema does not declare, or the schema requires something the handler defaults, becomes a production failure the moment the validator runs. One such case is already known; the point of this task is to find the rest before they find you.

**Files:**
- Create: `docs/SCHEMA-AUDIT.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/SCHEMA-AUDIT.md`, and a list of drift items that Task 3 fixes.

- [ ] **Step 1: List every property each handler actually reads**

```bash
grep -rn "input\.[a-z_]*" src/tools/*.ts | sed 's/.*input\.\([a-z_]*\).*/\1/' | sort -u
```

Then, per tool, list what its `define(...)` call declares. The registry is `src/tools/index.ts`.

- [ ] **Step 2: Write the table**

Create `docs/SCHEMA-AUDIT.md` with one row per tool, 28 rows:

```markdown
# Schema versus handler audit

Run 2026-08-27, before argument validation was switched on. These schemas had
never controlled runtime behaviour, so every disagreement between a declared
schema and its handler was latent until validation made it real.

| Tool | Reads but does not declare | Declares required, handler defaults | Verdict |
|---|---|---|---|
| search_people | | | clean |
| ... | | | |
```

For each tool record one of three verdicts:

- **clean** - every property the handler reads is declared, and every declared `required` really is required by the handler.
- **reads undeclared** - the handler reads `input.x` and the schema has no `x`. After validation, callers can never send it. Decide whether to declare it or delete the read.
- **required but defaulted** - the schema marks a property required while the handler supplies a default. After validation, a call omitting it starts failing.

- [ ] **Step 3: Record the one already known**

`export_data` declares `required: ["scope"]` at `src/tools/index.ts:239`. `exportData` reads `input.scope ?? "people"` at `src/tools/export.ts:79`. Under validation, `export_data({})` starts failing. Both cannot be right.

The verdict to record, for Task 3 to act on: **the handler is right and the schema is wrong.** A default that has existed since the tool shipped is the behaviour callers have; making the argument mandatory now is a breaking change dressed up as a fix.

- [ ] **Step 4: Check `import_roster`'s row items specifically**

`import_roster` declares its rows as an array of objects. Confirm what the item schema actually constrains, and whether the handler reads row properties the item schema does not name. This one matters more than the others because roster rows are caller-supplied bulk data, and a validator that rejects unknown nested keys could refuse an import that works today.

Record the finding. **Task 5 does not validate nested object properties**, and this step is where that decision is justified or overturned.

- [ ] **Step 5: Commit**

```bash
git add docs/SCHEMA-AUDIT.md
git commit -m "docs: audit every tool schema against its handler before enforcing them"
```

---

### Task 3: Fix the drift the audit found

**Files:**
- Modify: `src/tools/index.ts`
- Modify: `tests/export.test.ts` (or wherever `export_data`'s tests live)

**Interfaces:**
- Consumes: `docs/SCHEMA-AUDIT.md` from Task 2.
- Produces: a registry whose schemas can be enforced without breaking existing callers.

- [ ] **Step 1: Write a test pinning the behaviour you are keeping**

```typescript
// in the existing export_data test file
it("defaults scope to people when it is omitted", async () => {
  // Pinned deliberately before validation is switched on. The schema declared
  // scope required while the handler defaulted it; the handler's behaviour is
  // what callers have, so the schema is what changes. Without this test,
  // Task 6 could "fix" the drift in the other direction and break a caller.
  const result = await exportData(ctx, {} as never);
  expect(result.scope).toBe("people");
});
```

Adapt the context construction and the assertion to match the surrounding file's conventions; do not invent a new test harness.

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/export.test.ts`
Expected: PASS. The handler already behaves this way; this test records that it must keep doing so.

- [ ] **Step 3: Make the schema agree with the handler**

In `src/tools/index.ts`, find the `define("export_data", ...)` call and change its `obj(...)` third argument from `["scope"]` to `[]`.

- [ ] **Step 4: Apply every other fix the audit found**

Work the table. For each **reads undeclared** row, either declare the property or delete the read, and say in the commit message which and why. For each remaining **required but defaulted** row, apply the same rule as `export_data`: the handler's behaviour is what callers have.

If the audit found nothing else, say so explicitly in the commit message rather than leaving it silent.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts tests/
git commit -m "fix: align tool schemas with their handlers before enforcing them"
```

---

### Task 4: A failing test at the transport boundary

**This test must call through `buildServer`, not through a tool function.** The defect lives in the layer above the handlers: arguments are dropped between the MCP request and the handler. A test that calls `searchPeople` directly cannot see it, and would be the eighteenth test in this project that passes while guarding nothing.

**Files:**
- Create: `tests/validation-boundary.test.ts`

**Interfaces:**
- Consumes: `buildServer` from `src/mcp/server.ts`, and whatever harness the existing `tests/mcp.test.ts` uses to issue `tools/call` requests.
- Produces: the failing test Task 6 makes pass.

- [ ] **Step 1: Read how the existing transport tests issue a call**

```bash
sed -n '1,60p' tests/mcp.test.ts
```

Reuse that harness exactly. Do not build a second way of issuing a `tools/call`.

- [ ] **Step 2: Write the failing tests**

```typescript
// tests/validation-boundary.test.ts
//
// Every test here goes through the MCP tools/call boundary on purpose. The
// defect being fixed is that unknown arguments reach the handler and are
// ignored by property access, which is invisible to any test that calls a
// tool function directly.
import { describe, expect, it } from "vitest";
// Import the same helpers tests/mcp.test.ts uses to build a server and call a
// tool. Match its imports rather than inventing new ones.

describe("argument validation at the transport boundary", () => {
  // THE REPORTED BUG. A caller passed `cursor` to search_people, which declares
  // people_cursor and roster_cursor and no cursor. The argument was dropped,
  // the query restarted, and the identical page and identical token came back.
  // It was filed as a pagination defect. Pagination was correct.
  it("refuses an unknown argument instead of ignoring it", async () => {
    const result = await callTool("search_people", { query: "Mark", cursor: "eyJraW5kIjoi" });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error.code).toBe("invalid_input");
    // The reader is a model deciding what to do next, so the refusal has to
    // name the parameter that was wrong.
    expect(body.error.reason).toContain("cursor");
  });

  it("names what it would have accepted", async () => {
    const result = await callTool("search_people", { query: "Mark", cursor: "x" });
    const body = JSON.parse(result.content[0].text);
    expect(body.error.reason).toMatch(/people_cursor|roster_cursor/);
  });

  it("refuses a required argument that is missing", async () => {
    const result = await callTool("get_person", {});
    const body = JSON.parse(result.content[0].text);
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.reason).toContain("person_id");
  });

  it("refuses an argument of the wrong type", async () => {
    const result = await callTool("search_people", { query: 42 });
    const body = JSON.parse(result.content[0].text);
    expect(body.error.code).toBe("invalid_input");
  });

  it("refuses a value outside a declared enum", async () => {
    const result = await callTool("export_data", { scope: "toString" });
    const body = JSON.parse(result.content[0].text);
    expect(body.error.code).toBe("invalid_input");
  });

  // The most important negative in the file. A refused write must not have
  // written, and must not have consumed an idempotency key, or a retry with a
  // corrected argument replays a claim that never produced a result.
  it("writes nothing when it refuses a write", async () => {
    const before = await countPeople();
    const result = await callTool("create_person", {
      full_name: "Ada Lovelace",
      nonsense_field: "x",
    });
    expect(result.isError).toBe(true);
    expect(await countPeople()).toBe(before);
    const claims = await countIdempotencyKeys();
    expect(claims).toBe(0);
  });

  // Guards against a validator so strict it refuses ordinary calls. Without
  // this, "refuse everything" passes every test above.
  it("still accepts a valid call", async () => {
    const result = await callTool("search_people", { query: "nobody-by-this-name" });
    expect(result.isError).toBeFalsy();
  });

  it("still accepts a valid call that omits every optional argument", async () => {
    const result = await callTool("export_data", {});
    expect(result.isError).toBeFalsy();
  });

  // null is a value, not an absence. nullableStr declares type ["string","null"],
  // so a caller clearing a field must be able to send null.
  it("accepts null for a property declared nullable", async () => {
    const created = await callTool("create_person", { full_name: "Grace Hopper" });
    const id = JSON.parse(created.content[0].text).id;
    const result = await callTool("update_person", { person_id: id, job_title: null });
    expect(result.isError).toBeFalsy();
  });
});
```

Write `countPeople` and `countIdempotencyKeys` as small helpers over the test D1 binding, in the style the existing tests use.

- [ ] **Step 3: Run and confirm the shape of the failure**

Run: `npx vitest run tests/validation-boundary.test.ts`

Expected: the "refuses" tests FAIL, and they fail by **succeeding** rather than by throwing. `search_people` with a bogus `cursor` returns a normal result. That is the defect, reproduced.

Expected: the "still accepts" tests PASS already. If any of them fails now, stop: something other than validation is wrong and this plan is not the fix.

- [ ] **Step 4: Commit the failing test**

```bash
git add tests/validation-boundary.test.ts
git commit -m "test: reproduce arguments being silently dropped at the MCP boundary"
```

---

### Task 5: The validator

**Files:**
- Create: `src/validate.ts`
- Create: `tests/validate.test.ts`

**Interfaces:**
- Consumes: `JsonSchema` from `src/tools/schema.ts`, `ToolError` from `src/errors.ts`.
- Produces: `validateInput(toolName: string, schema: JsonSchema, input: unknown): void`, which returns nothing on success and throws `ToolError("invalid_input", ...)` on failure.

- [ ] **Step 1: Write the failing unit tests**

```typescript
// tests/validate.test.ts
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

  it("names every unknown property, not just the first", () => {
    const msg = reason(() => validateInput("t", schema, { person_id: "p_1", a: 1, b: 2 }));
    expect(msg).toContain("a");
    expect(msg).toContain("b");
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

  it("refuses a string that does not match a declared pattern", () => {
    expect(reason(() => validateInput("t", schema, { person_id: "re_1" }))).toContain("p_");
  });

  it("refuses a non-array where an array is declared", () => {
    reason(() => validateInput("t", schema, { person_id: "p_1", tags: "speaker" }));
  });

  it("refuses an array whose items are the wrong type", () => {
    reason(() => validateInput("t", schema, { person_id: "p_1", tags: [1] }));
  });

  // null is a value. nullableStr declares ["string","null"], and a caller
  // clearing a field sends null deliberately.
  it("accepts null only where null is declared", () => {
    expect(() => validateInput("t", schema, { person_id: "p_1", notes: null })).not.toThrow();
    reason(() => validateInput("t", schema, { person_id: "p_1", query: null }));
  });

  // undefined is JSON's absence. Treating it as a present-and-wrong value would
  // refuse `{person_id: "p_1", query: undefined}`, which serializes to a call
  // with no query at all.
  it("treats an explicitly undefined property as absent", () => {
    expect(() =>
      validateInput("t", schema, { person_id: "p_1", query: undefined })
    ).not.toThrow();
  });

  it("refuses input that is not an object", () => {
    reason(() => validateInput("t", schema, "nope"));
    reason(() => validateInput("t", schema, [1, 2]));
    reason(() => validateInput("t", schema, null));
  });

  // Refusals are logged, and logs are retained. A message carrying a note or a
  // name would put personal data into retained storage.
  it("never echoes a value into the message", () => {
    const msg = reason(() =>
      validateInput("t", schema, { person_id: "p_1", query: 42, secret_note: "Ada's address" })
    );
    expect(msg).not.toContain("Ada");
    expect(msg).not.toContain("42");
  });

  it("names the tool so a refusal is greppable", () => {
    expect(reason(() => validateInput("get_person", schema, {}))).toContain("get_person");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/validate.test.ts`
Expected: FAIL, cannot resolve `../src/validate`.

- [ ] **Step 3: Write the validator**

```typescript
// src/validate.ts
import { ToolError } from "./errors";
import type { JsonSchema } from "./tools/schema";

/**
 * The subset of JSON Schema this registry actually uses. Six keywords, all
 * produced by the helpers in tools/schema.ts. Anything else in a schema is
 * ignored rather than half-enforced, because a validator that pretends to
 * understand a keyword is worse than one that does not.
 */
interface PropertySchema {
  type?: string | string[];
  enum?: string[];
  pattern?: string;
  items?: { type?: string };
}

function matchesType(declared: string, value: unknown): boolean {
  switch (declared) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    default:
      // string, boolean. null is excluded here because typeof null is "object"
      // and would otherwise satisfy nothing, but Array.isArray guards arrays.
      return value !== null && !Array.isArray(value) && typeof value === declared;
  }
}

/**
 * Throws ToolError("invalid_input") describing every problem at once, or
 * returns. Never mutates `input`: no coercion and no default injection, so a
 * handler still sees exactly what the caller sent.
 *
 * Only top-level properties are checked. Nested object properties are not,
 * deliberately: `import_roster` accepts caller-supplied roster rows whose
 * shape is intentionally permissive, and recursively rejecting unknown keys
 * there would refuse imports that work today. See docs/SCHEMA-AUDIT.md.
 *
 * Messages name parameters and types and never a value. Refusals are logged
 * and logs are retained.
 */
export function validateInput(toolName: string, schema: JsonSchema, input: unknown): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolError(
      "invalid_input",
      `${toolName}: arguments must be an object`,
      `call ${toolName} again with an object of arguments`
    );
  }

  const value = input as Record<string, unknown>;
  const declared = Object.keys(schema.properties);
  const problems: string[] = [];

  // undefined is absence, not a wrong value. JSON cannot express it, but a
  // client building arguments in JavaScript can, and `{query: undefined}`
  // means a call with no query.
  const present = declared.length >= 0 ? Object.keys(value).filter((k) => value[k] !== undefined) : [];

  const unknown = present.filter((k) => !declared.includes(k));
  if (unknown.length > 0) {
    problems.push(
      `unknown ${unknown.length === 1 ? "argument" : "arguments"} ${unknown.sort().join(", ")}; ` +
        `${toolName} accepts ${declared.sort().join(", ")}`
    );
  }

  for (const key of schema.required ?? []) {
    if (!present.includes(key)) problems.push(`${key} is required`);
  }

  for (const key of present) {
    if (!declared.includes(key)) continue;
    const spec = schema.properties[key] as PropertySchema;
    const got = value[key];

    if (spec.type !== undefined) {
      const types = Array.isArray(spec.type) ? spec.type : [spec.type];
      if (!types.some((t) => matchesType(t, got))) {
        problems.push(`${key} must be ${types.join(" or ")}`);
        continue;
      }
    }

    if (spec.enum !== undefined && !spec.enum.includes(got as string)) {
      problems.push(`${key} must be one of ${spec.enum.join(", ")}`);
      continue;
    }

    if (spec.pattern !== undefined && typeof got === "string" && !new RegExp(spec.pattern).test(got)) {
      problems.push(`${key} must match ${spec.pattern}`);
      continue;
    }

    if (spec.items?.type !== undefined && Array.isArray(got)) {
      const itemType = spec.items.type;
      if (!got.every((item) => matchesType(itemType, item))) {
        problems.push(`every item in ${key} must be ${itemType}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new ToolError(
      "invalid_input",
      `${toolName}: ${problems.join("; ")}`,
      `call tools/list to see ${toolName}'s arguments`
    );
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/validate.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Confirm the strictness test is not blind**

Replace the body of `validateInput` with a single `throw new ToolError("invalid_input", "no")`. Run again. Expected: the "accepts" tests FAIL. That proves those tests are the ones stopping a validator from refusing everything, which every negative test in the file would otherwise tolerate. Revert and confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add src/validate.ts tests/validate.test.ts
git commit -m "feat: add a JSON Schema validator for the vocabulary this registry uses"
```

---

### Task 6: Enforce it at the boundary

**Files:**
- Modify: `src/mcp/server.ts`

**Interfaces:**
- Consumes: `validateInput` from `src/validate.ts`.
- Produces: every `tools/call` validated before any handler runs.

- [ ] **Step 1: Add the call**

In `src/mcp/server.ts`, inside the `CallToolRequestSchema` handler, the code currently reads:

```typescript
    const startedAt = Date.now();
    try {
      const result = await tool.run(ctx, (request.params.arguments ?? {}) as never);
```

Change it to:

```typescript
    const startedAt = Date.now();
    try {
      // Before anything else. A refused call must not reach a handler, must not
      // touch D1, and must not consume an idempotency key: a claim recorded for
      // a call that never produced a result is a key that can never replay.
      const args = request.params.arguments ?? {};
      validateInput(tool.name, tool.inputSchema, args);
      const result = await tool.run(ctx, args as never);
```

Add the import at the top of the file, in the existing import block:

```typescript
import { validateInput } from "../validate";
```

**It goes inside the existing `try`.** `validateInput` throws `ToolError`, and the `catch` below already turns a `ToolError` into a proper refusal with the right log line and the right error code. Putting it outside the try would produce an unhandled error and a 500 instead of a clean `invalid_input`.

- [ ] **Step 2: Run the boundary tests from Task 4**

Run: `npx vitest run tests/validation-boundary.test.ts`
Expected: PASS, all of them, including the two "still accepts" tests and the write-nothing test.

- [ ] **Step 3: Run everything**

Run: `npm test`

Expected: PASS. **If tests fail here, read each one before changing it.** A failure means a test was calling a tool with an argument its schema does not declare, which is drift the audit missed. The fix is to correct the schema or the test deliberately, and to add the case to `docs/SCHEMA-AUDIT.md`. Do not loosen the validator to make a test pass.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Confirm the enforcement is real**

Comment out the `validateInput` line. Run `npx vitest run tests/validation-boundary.test.ts`. Expected: the refusal tests FAIL. Restore it and confirm PASS. This is the mutation that proves the boundary test is testing the boundary.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts
git commit -m "fix: validate tool arguments at the MCP boundary instead of ignoring unknown ones"
```

---

### Task 7: Deploy, and find out what the client actually sends

The project's worst defects were found by running code, not reading it. Two of them were browser behaviours that 472 passing tests could not see. This task is the equivalent for validation.

**Files:**
- Modify: `docs/MEASUREMENTS.md`

**Interfaces:**
- Consumes: a deployed Worker.
- Produces: a recorded result, and a rollback if the smoke pass fails.

- [ ] **Step 1: Confirm plan 1 has been executed**

```bash
ls -t junco-backup-*.json.bz2 | head -1
grep -c "restore drill" docs/MEASUREMENTS.md
```

Expected: an archive exists, and the drill is recorded. **If either is missing, stop and execute plan 1 first.** This deploy changes refusal behaviour on a live instance; the backup is the precondition, not a nicety.

- [ ] **Step 2: Take a Time Travel bookmark**

```bash
npx wrangler d1 time-travel info junco-prm
```

Record the bookmark in the commit message for this deploy, per `docs/BACKUP.md`.

- [ ] **Step 3: Deploy**

```bash
npm test && npm run typecheck && npx wrangler deploy
```

Record the version id wrangler prints. That is what Step 6 rolls back to if needed.

- [ ] **Step 4: The smoke pass**

Through the real connector in Claude, not `curl`, call every read tool with the arguments actually in use, and each write tool against a throwaway person. All 28.

**This is the only way to discover what the Claude client puts in `arguments`.** The schemas have declared `additionalProperties: false` since they were written and nothing has ever enforced it. If any client injects a field of its own, this deploy is the moment it surfaces, and it will surface as every call failing.

- [ ] **Step 5: Record the result**

In `docs/MEASUREMENTS.md`, record the date, the deployed version id, that all 28 tools were exercised through the connector, and anything that refused unexpectedly. A clean pass is worth recording as plainly as a failure: it is the evidence that the client sends nothing extra.

- [ ] **Step 6: If the smoke pass fails**

```bash
npx wrangler rollback
```

Then fix forward. A tool refusing a call the client legitimately makes is drift the audit missed, and it belongs in `docs/SCHEMA-AUDIT.md` with the schema corrected, not in the validator as an exception.

- [ ] **Step 7: Commit**

```bash
git add docs/MEASUREMENTS.md
git commit -m "docs: record the validation deploy and its live smoke pass"
```

---

## Self-Review

**Spec coverage.** P2's three descriptions are Task 1. P3's requirements map as: the audit-first requirement is Task 2, the `export_data` drift resolution is Task 3, the reproducing test through the transport boundary is Task 4, the hand-written validator with the stated no-coercion and no-defaults rules is Task 5, enforcement before idempotency and database work is Task 6 Step 1, and the named rollback and live smoke pass are Task 7.

**One spec item deliberately narrowed.** The spec says unknown properties are "rejected at the top level". Task 5 implements exactly that and says why in a comment: `import_roster` takes caller-supplied roster rows, and recursive rejection could refuse imports that work today. Task 2 Step 4 is where that decision gets confirmed against the real schema rather than assumed.

**Placeholder scan.** No TBD or TODO. Every code step carries runnable code. Task 2's table is left with one worked row and a stated three-verdict vocabulary because its content is the output of running the grep in Step 1, which is a procedure rather than a placeholder. Task 3 Step 4 is conditional on that output for the same reason and says what to do when the answer is "nothing else".

**Type consistency.** `validateInput(toolName, schema, input)` is defined in Task 5 and called with exactly that signature in Task 6. `JsonSchema` and the `obj`/`str`/`id`/`enumOf`/`int`/`nullableStr`/`strArray` helpers are used as `src/tools/schema.ts` defines them. `ToolError(code, message, next)` matches `src/errors.ts`, where `next` is the third positional argument. The error body shape asserted in Task 4 (`body.error.code`, `body.error.reason`) must match what `toolErrorResult` actually serializes; Task 4 Step 1 reads the existing transport test first for this reason.

**One risk carried deliberately.** Task 6 changes refusal behaviour for all 28 tools on an instance in daily use. Task 7 Step 1 gates it on plan 1 having run, Step 2 takes a bookmark, and Step 6 names the rollback command. That is the mitigation; the risk does not go away.
