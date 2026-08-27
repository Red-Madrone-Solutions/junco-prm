# Junco PRM Descriptions and Argument Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make three tool descriptions match what their tools actually do, and make every tool refuse an argument it does not understand instead of silently ignoring it.

**Architecture:** No schema change and no new tools. Three descriptions are corrected in the registry. Then every `tools/call` is validated against the tool's existing `JsonSchema` at the transport boundary in `src/mcp/server.ts`, before any handler runs, using `@cfworker/json-schema` through the validator provider the MCP SDK already ships for edge runtimes. Two adaptations: `pattern` is stripped before validation so `assertId` keeps owning the `invalid_id` contract, and refusal messages are generated from the schema rather than from the library's error text.

**Tech Stack:** TypeScript, Cloudflare Workers, `@modelcontextprotocol/sdk` 1.30.0, `@cfworker/json-schema` ^4.1.1, vitest 4.1.11 with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-08-27-junco-prm-read-surface-and-export-design.md` (phases P2 and P3)

**This is plan 2 of 3.** Plan 1 (`2026-08-27-junco-prm-backup-and-restore.md`) builds the backup and must be executed first: this plan changes refusal behaviour on a live instance that currently has no backup. Plan 3 covers the read surface and `update_followup`.

## Revised 2026-08-27 after a four-agent code review

Nine defects, each verified against the repository before being accepted. Two would have broken working behaviour on a live instance.

**The validator is no longer hand-written.** The first draft walked the six JSON Schema keywords this registry uses, on the grounds that Ajv compiles with `new Function`, which workerd forbids. That premise was right and the conclusion was wrong: the MCP SDK ships `CfWorkerJsonSchemaValidator` at `@modelcontextprotocol/sdk/validation/cfworker`, backed by `@cfworker/json-schema`, which validates without code generation precisely for edge runtimes. A reviewer found it in `node_modules`.

The deciding argument is the failure mode the hand-written version carried: a schema keyword it did not recognize was **silently ignored**, which recreates the exact defect this plan exists to fix, one level up. Bundle headroom is not a concern; the Worker is 182 KiB gzipped today.

**Enforcing `pattern` would have broken the error design.** `tests/mcp.test.ts:140` is named "maps an id of the wrong kind to invalid_id, not to a crash" and passes `person_id: "re_1"`. Any validator enforcing `^p_` returns `invalid_input` instead, collapsing a distinction `src/ids.ts` exists to make. Three of four reviewers found this. `pattern` is now stripped before validation and `assertId` keeps the contract.

**The audit had three verdicts and needed four.** Nullability drift is real and already present: `label`, `location`, `event`, and `note` are declared `str` while their handler interfaces accept `null`. Switching validation on without fixing those refuses calls that work today. `log_encounter.occurred_on` is additionally a second `export_data`-shaped case, declared required and defaulted by the handler.

**The audit method could not find any of that.** A grep for `input\.[a-z_]*` misses destructuring, misses nullability entirely, and loses tool context. Task 2 now reads the exported input interfaces.

**Task 4's harness did not exist.** `callTool` was invented, and `rpc` at `tests/mcp.test.ts:24` is a private function that cannot be imported. It is extracted to a shared helper first.

**Two of the "reproducing" tests already pass.** `search.ts:198` validates query type and `export.ts:83` validates the scope enum, both throwing `invalid_input` from inside the handler. Only the unknown-argument case reproduces the defect. The red-phase expectations are corrected.

**The idempotency assertion guarded nothing.** It claimed to prove a refused write consumes no key while sending no `idempotency_key` at all. It now sends one and spies on the handler.

**Rollback pointed at the wrong version.** Task 7 recorded the newly deployed id and called it the rollback target. That is the candidate being rolled back from.

### One review finding rejected, with evidence

A reviewer warned that unknown property names would be echoed into retained logs. `logToolCall` in `src/log.ts` accepts `requestId`, `tool`, `durationMs`, `outcome`, and `code`, and never a message. Refusal text reaches the model in the tool result and does not reach the log.

## Global Constraints

- **No em dashes or en dashes anywhere**, in code, comments, docs, or commit messages. Plain hyphens only.
- **No `console` calls anywhere in `src/`** except `src/log.ts`. A repository-wide test enforces this and it is a security property, not style.
- **The seven error codes are a closed set**: `invalid_input`, `invalid_id`, `not_found`, `conflict`, `confirmation_required`, `confirmation_invalid`, `limit_exceeded`. Adding an eighth is a spec change. Validation failures are `invalid_input`; malformed ids stay `invalid_id` and stay with `assertId`.
- **No personal data in error messages.** A refusal names parameters and types, never a value.
- **Plan 1 must have been executed**, with an archive taken and a restore drilled, before Task 8 deploys.
- **Take a Time Travel bookmark before the deploy**, per `docs/BACKUP.md`.
- **One new runtime dependency only**: `@cfworker/json-schema`. Nothing else is added.

---

## File Structure

**Created:**

- `src/validate.ts` - the boundary validator: strips `pattern`, delegates the verdict, writes the message.
- `tests/validate.test.ts` - unit tests for the validator.
- `tests/helpers/rpc.ts` - the `tools/call` harness, extracted from `tests/mcp.test.ts` so more than one file can use it.
- `tests/validation-boundary.test.ts` - proves refusal happens at the boundary and no handler runs.
- `docs/SCHEMA-AUDIT.md` - the schema-versus-handler table for all 28 tools.

**Modified:**

- `src/tools/index.ts` - three descriptions, plus the drift the audit finds.
- `src/mcp/server.ts` - one call, before `tool.run`.
- `tests/mcp.test.ts` - imports the extracted `rpc` instead of defining it.
- `package.json` - one dependency.

---

### Task 1: Three descriptions that currently misdescribe real behaviour

Documentation only. No behaviour change, no schema change. Separable from everything else here.

**Files:**
- Modify: `src/tools/index.ts`

**Interfaces:**
- Consumes: nothing. Produces: nothing other tasks depend on.

- [ ] **Step 1: Read each description before changing it**

```bash
grep -n -A3 'define(\n*\s*"promote_roster_entry"' src/tools/index.ts
grep -n -A4 '"get_roster_entry"' src/tools/index.ts
grep -n -A6 '"import_roster"' src/tools/index.ts
```

**Extend these descriptions; do not replace them.** The first draft of this plan supplied whole replacement strings, which would have deleted existing sentences that are still true. Add the new sentences to what is there.

- [ ] **Step 2: `promote_roster_entry` stores the roster row's email as a contact**

Append to its description:

```typescript
        " If the roster row carries an email, this call stores it as a person contact. That " +
        "differs from create_person, whose email is used for duplicate detection only and is not " +
        "stored. Calling add_contact afterwards with the same address is a no-op rather than a " +
        "duplicate, because contacts are unique per person, type, and normalized value.",
```

Confirmed by promoting a person whose roster row carried an address and reading the result back; the control case, a roster row with no email, returned empty contacts. The no-op claim is `src/tools/attributes.ts:45`, `ON CONFLICT (person_id, contact_type, normalized_value) DO NOTHING`.

- [ ] **Step 3: Document the `external_row_key` discriminator**

Append to `get_roster_entry`'s description:

```typescript
        " Provenance records carry external_row_key with a tier prefix showing how identity was " +
        "derived: 'k:' plus the source's own row id when the import supplied one, else 'e:' plus " +
        "the normalized email, else 'h:' plus a hash of name and organization. Stability follows " +
        "the tier: a k: key is as stable as the source id, an e: key changes if the email " +
        "changes, an h: key changes if the name or organization changes.",
```

Built at `src/normalize.ts:130`.

- [ ] **Step 4: Say what `import_roster` returning counts costs the caller**

Append to its description:

```typescript
        " This returns counts, not entry ids, and no call maps a source row to the re_ id it " +
        "created. Plan an import knowing that, rather than discovering it after the rows are " +
        "staged.",
```

**Note for plan 3:** that sentence is deleted there, when the roster read tools return `external_row_key`. Flagged so a later reader does not find a stale warning and trust it.

- [ ] **Step 5: Confirm nothing else changed**

Run: `npm test` and `npm run typecheck`
Expected: PASS, unchanged count. If a test fails, it was asserting on description text; move that assertion deliberately.

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts
git commit -m "docs: correct three tool descriptions that misdescribed real behaviour"
```

---

### Task 2: The schema-versus-handler audit

**Validation must not be switched on before this exists.** These schemas have never controlled runtime behaviour, so every disagreement between a declared schema and its handler becomes a production failure the moment the validator runs.

**Files:**
- Create: `docs/SCHEMA-AUDIT.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/SCHEMA-AUDIT.md` and a drift list Task 3 fixes.

- [ ] **Step 1: Read the input interfaces, not just the property accesses**

The first draft used `grep -rn "input\.[a-z_]*"` alone. That misses destructuring (`const { person_id } = input`), misses properties read by helpers, and cannot see nullability at all. Start from the declared interfaces instead:

```bash
grep -rn -A12 "^export interface .*Input" src/tools/*.ts
```

Then, per tool, compare that interface against the `obj({...})` in its `define(...)` call.

- [ ] **Step 2: Write the table with four verdicts**

Create `docs/SCHEMA-AUDIT.md`:

```markdown
# Schema versus handler audit

Run 2026-08-27, before argument validation was switched on. These schemas had
never controlled runtime behaviour, so every disagreement below was latent
until validation made it real.

| Tool | Verdict | Detail |
|---|---|---|
| search_people | clean | |
```

Four verdicts, not three. The fourth is the one the first draft missed:

- **clean** - every property the handler reads is declared, every `required` really is required, and declared types match what the handler accepts.
- **reads undeclared** - the handler reads a property the schema does not declare. After validation, callers can never send it.
- **required but defaulted** - the schema marks a property required while the handler supplies a default. After validation, omitting it starts failing.
- **nullability mismatch** - the schema declares `str` (string only) while the handler's interface accepts `string | null`. **After validation, sending `null` starts failing.** This is the category that refuses calls which work today.

- [ ] **Step 3: Record the five already known**

These were found during review and must appear in the table:

| Tool | Verdict | Detail |
|---|---|---|
| `export_data` | required but defaulted | `required: ["scope"]` at `index.ts:239`, handler reads `input.scope ?? "people"` at `export.ts:79` |
| `log_encounter` | required but defaulted | `occurred_on` required in the schema, `resolveOccurredOn` defaults it at `encounters.ts:69` |
| `add_contact` | nullability mismatch | `label: str(...)` at `index.ts:315`, interface accepts `string \| null` |
| `log_encounter` | nullability mismatch | `location` and `event` declared `str`, interface accepts null |
| `create_followup` | nullability mismatch | `note` declared `str`, interface accepts null |

**The verdict for every "required but defaulted" case is that the handler is right.** A default that has existed since the tool shipped is the behaviour callers have; making the argument mandatory now is a breaking change dressed as a fix.

**The verdict for every nullability mismatch is that the handler is right too.** The interface accepting null is deliberate: null is how a caller clears a field.

- [ ] **Step 4: Check `import_roster`'s row items**

Roster rows are caller-supplied bulk data. Confirm what the item schema constrains and whether handlers read row properties it does not name.

**This decides whether validation may reject unknown nested properties.** Record the finding; Task 5's design turns on it.

- [ ] **Step 5: Commit**

```bash
git add docs/SCHEMA-AUDIT.md
git commit -m "docs: audit every tool schema against its handler before enforcing them"
```

---

### Task 3: Fix the drift the audit found

**Files:**
- Modify: `src/tools/index.ts`, and the tests that pin the behaviour being kept.

**Interfaces:**
- Consumes: `docs/SCHEMA-AUDIT.md`.
- Produces: a registry whose schemas can be enforced without breaking existing callers.

- [ ] **Step 1: Pin the behaviours you are keeping, before changing any schema**

```typescript
// tests/schema-drift.test.ts
// Written before the schemas change, so a later "fix" in the wrong direction
// is caught. Each of these is a call that works today and must keep working.
import { describe, expect, it } from "vitest";

describe("behaviours the schemas must be made to agree with", () => {
  it("export_data defaults scope to people when omitted", async () => {
    const result = await listOrExport(ctx, {} as never);
    expect(result.scope).toBe("people");
  });

  it("log_encounter defaults occurred_on to today when omitted", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    const result = await logEncounter(ctx, { person_id: person.id, summary: "met" } as never);
    expect(result.occurred_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("add_contact accepts a null label", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      addContact(ctx, { person_id: person.id, contact_type: "email", value: "a@b.test", label: null })
    ).resolves.toBeTruthy();
  });

  it("log_encounter accepts null location and event", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      logEncounter(ctx, { person_id: person.id, occurred_on: "2026-08-27", summary: "x", location: null, event: null })
    ).resolves.toBeTruthy();
  });

  it("create_followup accepts a null note", async () => {
    const person = await createPerson(ctx, { full_name: "Ada" });
    await expect(
      createFollowup(ctx, { person_id: person.id, due_on: "2026-09-09", note: null })
    ).resolves.toBeTruthy();
  });
});
```

Adapt the context construction to the surrounding files' conventions. Note `createFollowup` returns `{ followup, person }`, not a follow-up.

- [ ] **Step 2: Run them**

Run: `npx vitest run tests/schema-drift.test.ts`
Expected: PASS. The handlers already behave this way; these tests record that they must keep doing so.

- [ ] **Step 3: Make the schemas agree with the handlers**

In `src/tools/index.ts`:

- `export_data`: change the `obj(...)` required array from `["scope"]` to `[]`.
- `log_encounter`: remove `occurred_on` from its required array.
- `add_contact`: `label: str(...)` becomes `label: nullableStr(...)`.
- `log_encounter`: `location` and `event` become `nullableStr(...)`.
- `create_followup`: `note` becomes `nullableStr(...)`.

Then apply every other row the audit produced, by the same two rules: the handler is right about defaults, and the handler is right about nullability. If the audit found nothing else, say so explicitly in the commit message rather than leaving it silent.

- [ ] **Step 4: Run and commit**

Run: `npm test` and `npm run typecheck`. Expected: PASS.

```bash
git add src/tools/index.ts tests/schema-drift.test.ts
git commit -m "fix: align tool schemas with their handlers before enforcing them"
```

---

### Task 4: Extract the `tools/call` harness

Small, and it unblocks Task 5. `rpc` is a private function at `tests/mcp.test.ts:24`, so no second file can issue a `tools/call` without duplicating it.

**Files:**
- Create: `tests/helpers/rpc.ts`
- Modify: `tests/mcp.test.ts`

**Interfaces:**
- Produces: `rpc(method: string, params: unknown, props?: unknown)` and a `callTool(name: string, args: unknown)` convenience wrapper returning the parsed tool payload.

- [ ] **Step 1: Move it**

Cut `rpc` from `tests/mcp.test.ts` into `tests/helpers/rpc.ts` unchanged, export it, and import it back in `tests/mcp.test.ts`. Add alongside it:

```typescript
/**
 * Issues a tools/call and returns the parsed payload plus whether the result
 * was an error. Every boundary test uses this rather than reaching into a
 * tool function, because the defect these tests exist for lives above the
 * handlers.
 */
export async function callTool(name: string, args: unknown) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, payload: JSON.parse(result.content[0]!.text) };
}
```

- [ ] **Step 2: Confirm nothing broke**

Run: `npm test`
Expected: PASS, unchanged count. This is a pure move.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/rpc.ts tests/mcp.test.ts
git commit -m "test: extract the tools/call harness so more than one file can use it"
```

---

### Task 5: A failing test at the transport boundary

**Files:**
- Create: `tests/validation-boundary.test.ts`

**Interfaces:**
- Consumes: `callTool` from `tests/helpers/rpc.ts`.
- Produces: the failing test Task 7 makes pass.

- [ ] **Step 1: Write the tests, with honest expectations about which fail today**

```typescript
// tests/validation-boundary.test.ts
//
// Every test goes through the MCP tools/call boundary on purpose. The defect
// being fixed is that unknown arguments reach the handler and are ignored by
// property access, which is invisible to any test calling a tool directly.
import { describe, expect, it, vi } from "vitest";
import { callTool } from "./helpers/rpc";
import { TOOLS } from "../src/tools/index";

describe("the defect: unknown arguments are dropped", () => {
  // THE REPORTED BUG. A caller passed `cursor` to search_people, which declares
  // people_cursor and roster_cursor and no cursor. The argument was dropped,
  // the query restarted, and the identical page and identical token came back.
  // Filed as a pagination defect. Pagination was correct.
  it("refuses an unknown argument instead of ignoring it", async () => {
    const { isError, payload } = await callTool("search_people", {
      query: "Mark",
      cursor: "eyJraW5kIjoi",
    });
    expect(isError).toBe(true);
    expect(payload.error.code).toBe("invalid_input");
    expect(payload.error.reason).toContain("cursor");
  });

  it("names what it would have accepted", async () => {
    const { payload } = await callTool("search_people", { query: "Mark", cursor: "x" });
    expect(payload.error.reason).toMatch(/people_cursor|roster_cursor/);
  });

  it("refuses an unknown argument on a write without writing", async () => {
    const spy = vi.spyOn(TOOLS.create_person, "run");
    const before = await countPeople();
    const { isError } = await callTool("create_person", {
      full_name: "Ada Lovelace",
      idempotency_key: "boundary-test-1",
      nonsense_field: "x",
    });
    expect(isError).toBe(true);
    // The handler must not run at all. Counting rows alone would pass even if
    // the handler ran and happened to fail after claiming a key.
    expect(spy).not.toHaveBeenCalled();
    expect(await countPeople()).toBe(before);
    // And the key must be reclaimable. A claim recorded for a call that never
    // produced a result is a key that can never replay.
    expect(await idempotencyKeyExists("boundary-test-1")).toBe(false);
    spy.mockRestore();
  });
});

describe("refusals that already work, and must keep working", () => {
  // These pass BEFORE the validator exists, because the handlers validate
  // internally: search.ts:198 for query type, export.ts:83 for the scope enum.
  // They are here as regression guards, not as reproductions of the defect.
  it("refuses a wrong-typed query", async () => {
    const { payload } = await callTool("search_people", { query: 42 });
    expect(payload.error.code).toBe("invalid_input");
  });

  it("refuses a scope outside the enum", async () => {
    const { payload } = await callTool("export_data", { scope: "toString" });
    expect(payload.error.code).toBe("invalid_input");
  });

  // THE CONTRACT THE VALIDATOR MUST NOT BREAK. src/ids.ts distinguishes a
  // malformed id from a bad argument, and tests/mcp.test.ts:140 depends on it.
  // A validator enforcing the ^p_ pattern would return invalid_input here.
  it("still reports invalid_id for an id of the wrong kind", async () => {
    const { payload } = await callTool("log_encounter", {
      person_id: "re_1",
      occurred_on: "2026-08-20",
      summary: "x",
    });
    expect(payload.error.code).toBe("invalid_id");
  });
});

describe("calls that must keep succeeding", () => {
  // Without these, "refuse everything" passes every negative test above.
  it("accepts a valid call", async () => {
    const { isError } = await callTool("search_people", { query: "nobody-by-this-name" });
    expect(isError).toBe(false);
  });

  it("accepts a valid call that omits every optional argument", async () => {
    const { isError } = await callTool("export_data", {});
    expect(isError).toBe(false);
  });

  it("accepts null for a property the handler treats as nullable", async () => {
    const created = await callTool("create_person", { full_name: "Grace Hopper" });
    const { isError } = await callTool("update_person", {
      person_id: created.payload.id,
      job_title: null,
    });
    expect(isError).toBe(false);
  });
});
```

Write `countPeople` and `idempotencyKeyExists` as small helpers over the test D1 binding, in the style the existing tests use.

- [ ] **Step 2: Run and confirm which fail**

Run: `npx vitest run tests/validation-boundary.test.ts`

Expected: the three tests in **"the defect"** FAIL, and they fail by **succeeding** rather than throwing.

Expected: everything in **"refusals that already work"** and **"calls that must keep succeeding"** PASSES already. **If any of those fails now, stop** - something other than validation is wrong and this plan is not the fix.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/validation-boundary.test.ts
git commit -m "test: reproduce arguments being silently dropped at the MCP boundary"
```

---

### Task 6: The validator

**Files:**
- Create: `src/validate.ts`, `tests/validate.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `JsonSchema` from `src/tools/schema.ts`, `ToolError` from `src/errors.ts`, `CfWorkerJsonSchemaValidator` from `@modelcontextprotocol/sdk/validation/cfworker`.
- Produces: `validateInput(toolName: string, schema: JsonSchema, input: unknown): void`, returning nothing on success and throwing `ToolError("invalid_input", ...)` on failure.

- [ ] **Step 1: Add the dependency and confirm it loads under workerd**

```bash
npm install --save @cfworker/json-schema@^4.1.1
```

It is an optional peer dependency of the SDK, declared in its `package.json` as `"@cfworker/json-schema": "^4.1.1"` with `optional: true`. The export path is `@modelcontextprotocol/sdk/validation/cfworker`.

Then confirm it survives the Workers bundle, because a library that uses `eval` or `new Function` fails only at runtime:

```bash
npx wrangler deploy --dry-run --outdir /tmp/junco-bundle-check
```

Expected: success, and a gzip size still well under the limit. It was 182 KiB before this dependency. **If the dry run fails, stop and record why**; the fallback is a hand-written walker over the six keywords `src/tools/schema.ts` emits, plus a registry test that no schema uses a seventh.

- [ ] **Step 2: Write the failing tests**

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
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/validate.test.ts`
Expected: FAIL, cannot resolve `../src/validate`.

- [ ] **Step 4: Write the validator**

```typescript
// src/validate.ts
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { ToolError } from "./errors";
import type { JsonSchema } from "./tools/schema";

/**
 * Real JSON Schema, not a reimplementation of the parts we happen to use.
 *
 * An earlier draft walked the six keywords `src/tools/schema.ts` emits. Its
 * failure mode was that a keyword it did not recognize was silently ignored,
 * which is the same defect this module exists to fix, one level up. This
 * library validates without code generation, which is why it works under
 * workerd where Ajv's `new Function` does not.
 *
 * `shortcircuit: false` so a caller is told everything that is wrong in one
 * refusal rather than discovering problems one round trip at a time.
 */
const provider = new CfWorkerJsonSchemaValidator({ shortcircuit: false });
const validators = new Map<string, ReturnType<typeof provider.getValidator>>();

/**
 * `pattern` is REMOVED before validation, and that is deliberate.
 *
 * `id("p", "Person")` puts `^p_` in the schema so an agent reading tools/list
 * sees the prefix. Enforcing it here would turn `person_id: "re_1"` into
 * `invalid_input`, when `src/ids.ts` reports it as `invalid_id` with a next
 * step naming promote_roster_entry. That distinction is the error design, it
 * is asserted by tests/mcp.test.ts, and the boundary must not flatten it.
 *
 * Type is still enforced, so a non-string id is still refused here.
 */
function withoutPatterns(schema: JsonSchema): JsonSchema {
  const properties: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (spec !== null && typeof spec === "object" && "pattern" in spec) {
      const { pattern, ...rest } = spec as Record<string, unknown>;
      properties[key] = rest;
    } else {
      properties[key] = spec;
    }
  }
  return { ...schema, properties };
}

function validatorFor(toolName: string, schema: JsonSchema) {
  let validator = validators.get(toolName);
  if (!validator) {
    validator = provider.getValidator(withoutPatterns(schema) as never);
    validators.set(toolName, validator);
  }
  return validator;
}

/**
 * Turns one library error into a sentence a model can act on.
 *
 * The library reports `/limit: must be integer`. What a caller needs is the
 * property name and what the schema would have accepted, so the message is
 * built from the schema rather than passed through. It never contains a value:
 * refusals reach the model, and echoing a note or a name into one is how
 * personal data ends up somewhere nobody expected.
 */
function describe(schema: JsonSchema, location: string): string {
  const key = location.replace(/^\//, "").split("/")[0];
  if (!key) return "arguments must be an object";
  const spec = schema.properties[key] as { type?: string | string[]; enum?: string[] } | undefined;
  if (!spec) {
    const declared = Object.keys(schema.properties).slice().sort().join(", ");
    return `unknown argument ${key}; accepted arguments are ${declared}`;
  }
  if (spec.enum) return `${key} must be one of ${spec.enum.join(", ")}`;
  const types = Array.isArray(spec.type) ? spec.type.join(" or ") : spec.type;
  return `${key} must be ${types ?? "of the declared type"}`;
}

export function validateInput(toolName: string, schema: JsonSchema, input: unknown): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolError(
      "invalid_input",
      `${toolName}: arguments must be an object`,
      `call ${toolName} again with an object of arguments`
    );
  }

  // undefined is absence, not a wrong value. JSON cannot express it, but a
  // client building arguments in JavaScript can, and `{query: undefined}`
  // means a call with no query.
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value !== undefined) cleaned[key] = value;
  }

  const result = validatorFor(toolName, schema)(cleaned);
  if (result.valid) return;

  const seen = new Set<string>();
  for (const part of result.errorMessage.split("; ")) {
    const location = part.split(":")[0] ?? "";
    seen.add(describe(schema, location.trim()));
  }
  // Missing required properties are reported by the library against the object
  // itself rather than against the property, so name them explicitly.
  for (const key of schema.required ?? []) {
    if (!(key in cleaned)) seen.add(`${key} is required`);
  }

  throw new ToolError(
    "invalid_input",
    `${toolName}: ${[...seen].join("; ")}`,
    `call tools/list to see ${toolName}'s arguments`
  );
}
```

**Step 5 of this task is where the message shape gets corrected against reality.** The library's `errorMessage` is `instanceLocation: error` joined by `"; "`, per `cfworker-provider.js`. If the observed shape differs, fix `describe` and the split to match what it actually returns rather than what this plan predicts.

- [ ] **Step 5: Run the tests and correct the parsing against real output**

Run: `npx vitest run tests/validate.test.ts`

If messages are wrong, log one real `result.errorMessage` in a scratch test, read it, and adjust. Do not adjust the assertions to match a bad message.

Expected when done: PASS, 19 tests.

- [ ] **Step 6: Confirm the strictness test is not blind**

Replace the body of `validateInput` with a single `throw new ToolError("invalid_input", "no")`. Run again. Expected: the "accepts" tests FAIL. That proves those tests are what stops a validator refusing everything. Revert and confirm PASS.

- [ ] **Step 7: Commit**

```bash
git add src/validate.ts tests/validate.test.ts package.json package-lock.json
git commit -m "feat: validate tool arguments with a codegen-free JSON Schema validator"
```

---

### Task 7: Enforce it at the boundary

**Files:**
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Add the call**

`src/mcp/server.ts` currently reads:

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

Add to the existing import block:

```typescript
import { validateInput } from "../validate";
```

**It goes inside the existing `try`.** `validateInput` throws `ToolError`, and the `catch` below already turns that into a proper refusal with the right log line and code. Outside the try it would produce an unhandled error and a 500 instead of a clean `invalid_input`.

- [ ] **Step 2: Run the boundary tests**

Run: `npx vitest run tests/validation-boundary.test.ts`
Expected: PASS, all three groups, including "still reports invalid_id for an id of the wrong kind".

- [ ] **Step 3: Run everything**

Run: `npm test`

Expected: PASS. **If tests fail here, read each one before changing it.** A failure means a test calls a tool with an argument its schema does not declare, which is drift Task 2 missed. Correct the schema or the test deliberately and add the case to `docs/SCHEMA-AUDIT.md`. Do not loosen the validator to make a test pass.

Run: `npm run typecheck`. Expected: clean.

- [ ] **Step 4: Confirm the enforcement is real**

Comment out the `validateInput` line and run the boundary tests. Expected: the "defect" group FAILS. Restore and confirm PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts
git commit -m "fix: validate tool arguments at the MCP boundary instead of ignoring unknown ones"
```

---

### Task 8: Deploy, and find out what the client actually sends

- [ ] **Step 1: Confirm the preconditions**

```bash
ls -t junco-backup-*.json.bz2 | head -1
grep -c "restore drill" docs/MEASUREMENTS.md
npx wrangler d1 time-travel info junco-prm
```

An archive must exist and the drill must be recorded, both from plan 1. Record the bookmark. **If either is missing, stop and execute plan 1 first.**

- [ ] **Step 2: Capture the version you would roll back TO, before deploying**

```bash
npx wrangler deployments list | head -20
```

Record the **currently active** version id. The first draft of this plan recorded the newly deployed id and called it the rollback target, which is the version being rolled back from.

- [ ] **Step 3: Deploy**

```bash
npm test && npm run typecheck && npx wrangler deploy
```

- [ ] **Step 4: The smoke pass**

Through the real connector in Claude, not `curl`. Read tools can be called freely. For writes, work through one throwaway person and one throwaway roster source so that `import_roster`, `finalize_import`, `promote_roster_entry`, and `purge_roster_source` are each exercised once; a single throwaway person does not reach them.

**This is the only way to discover what the Claude client puts in `arguments`.** The schemas have declared `additionalProperties: false` since they were written and nothing has ever enforced it. If any client injects a field of its own, this deploy is when it surfaces, and it surfaces as every call failing.

- [ ] **Step 5: Record the result**

In `docs/MEASUREMENTS.md`: the date, the deployed version id, the previous version id, that all 28 tools were exercised through the connector, and anything that refused unexpectedly. A clean pass is worth recording as plainly as a failure.

- [ ] **Step 6: If the smoke pass fails**

```bash
npx wrangler rollback <the-version-id-from-step-2>
```

Then fix forward. A tool refusing a call the client legitimately makes is drift the audit missed; it belongs in `docs/SCHEMA-AUDIT.md` with the schema corrected, not in the validator as an exception.

- [ ] **Step 7: Commit**

```bash
git add docs/MEASUREMENTS.md
git commit -m "docs: record the validation deploy and its live smoke pass"
```

---

## Self-Review

**Spec coverage.** P2's three descriptions are Task 1. P3's requirements map as: the audit-first requirement is Task 2, drift resolution is Task 3, the reproducing test through the transport boundary is Tasks 4 and 5, the validator with no coercion and no default injection is Task 6, enforcement before idempotency and database work is Task 7 Step 1, and the named rollback and live smoke pass are Task 8.

**Two spec items implemented differently from how the spec describes them, both deliberately.** The spec says the validator is hand-written over the vocabulary in use; it is now a codegen-free library, for the reason given in the revision note, and the spec should be amended to match. The spec says unknown properties are rejected "at the top level"; that remains true, and Task 2 Step 4 is where nested rejection is confirmed unsafe for `import_roster` rather than assumed.

**One spec requirement is deliberately not met.** The spec implies every declared constraint is enforced. `pattern` is not, because enforcing it would collapse `invalid_id` into `invalid_input`. That is recorded in the code, in a test, and here.

**Placeholder scan.** No TBD or TODO. Task 2's table carries five worked rows and a stated four-verdict vocabulary; the rest is the output of Step 1, which is a procedure. Task 6 Step 5 tells the implementer to correct the message parsing against real library output rather than trusting this plan's prediction of it, which is a known-unknown with a method.

**Type consistency.** `validateInput(toolName, schema, input)` is defined in Task 6 and called with that signature in Task 7. `callTool(name, args)` returning `{isError, payload}` is defined in Task 4 and used in Task 5. `createFollowup` is referred to as returning `{ followup, person }` in Task 3, matching `src/tools/followups.ts`. `ToolError(code, message, next)` matches `src/errors.ts`.

**Two risks carried deliberately.** Task 7 changes refusal behaviour for 28 tools on an instance in daily use, mitigated by Task 8's gate, bookmark, and named rollback. And Task 6 adds a runtime dependency to a project that has been careful about them, mitigated by Step 1's bundle check and by the fallback recorded there.
