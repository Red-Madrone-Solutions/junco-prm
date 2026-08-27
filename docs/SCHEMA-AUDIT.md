# Schema versus handler audit

Run 2026-08-27, before argument validation was switched on. These schemas had
never controlled runtime behaviour, so every disagreement below was latent
until validation made it real. Verified against 545 tests across 43 files
(`npx vitest run`); this task changed no code, so that count did not move.

**Method.** For each tool, the exported `*Input` interface in `src/tools/*.ts`
was read in full (not grepped for property accesses), then compared field by
field against the `obj({...})` call that builds its schema in
`src/tools/index.ts`. Where a tool's input has no exported interface
(`get_roster_entry`, `list_roster_sources`), the handler's inline parameter
type was used instead. Id patterns from `id()` were not treated as drift:
Task 6 strips patterns before validating on purpose, so `assertId` keeps
reporting `invalid_id` regardless of what the JSON Schema says.

Four verdicts:

- **clean** - every property the handler reads is declared, every `required`
  really is required, and declared types match what the handler accepts.
- **reads undeclared** - the handler reads a property the schema does not
  declare. After validation, callers can never send it.
- **required but defaulted** - the schema marks a property required while the
  handler supplies a default. After validation, omitting it starts failing.
- **nullability mismatch** - the schema declares `str` (string only) while the
  handler's interface accepts `string | null`. After validation, sending
  `null` starts failing. This is the category that refuses calls which work
  today.

**For every "required but defaulted" row, the handler is right.** A default
that has existed since the tool shipped is the behaviour callers have; making
the argument mandatory now is a breaking change dressed as a fix.

**For every "nullability mismatch" row, the handler is right too.** The
interface accepting null is deliberate: null is how a caller clears a field.

## Table

| Tool | Verdict | Detail |
|---|---|---|
| search_people | clean | |
| get_person | clean | |
| list_encounters | clean | |
| list_due | clean | |
| list_roster_sources | clean | takes no input |
| get_roster_entry | clean | |
| export_data | required but defaulted | `required: ["scope"]` at `index.ts:244`, handler reads `input.scope ?? "people"` at `export.ts:79` |
| create_person | clean | |
| update_person | clean | see note below on `full_name` |
| archive_person | clean | |
| unarchive_person | clean | |
| delete_person | clean | |
| add_contact | nullability mismatch | `label: str(...)` at `index.ts:320`, interface (`AddContactInput`, `attributes.ts:16`) accepts `string \| null` |
| remove_contact | clean | |
| add_link | clean | |
| remove_link | clean | |
| add_tags | clean | |
| remove_tags | clean | |
| log_encounter | required but defaulted | `occurred_on` required in the schema (`index.ts:407`), `resolveOccurredOn` defaults it to today when omitted (`encounters.ts:69`) |
| log_encounter | nullability mismatch | `location` and `event` declared `str` at `index.ts:404-405`, interface (`LogEncounterInput`, `encounters.ts:46-47`) accepts `string \| null` for both |
| update_encounter | clean | |
| delete_encounter | clean | |
| create_followup | nullability mismatch | `note: str(...)` at `index.ts:452`, interface (`CreateFollowupInput`, `followups.ts:57`) accepts `string \| null` |
| complete_followup | clean | |
| cancel_followup | clean | |
| import_roster | clean | top-level fields match; see Step 4 below for the row-item schema, which is a separate question |
| finalize_import | clean | |
| promote_roster_entry | clean | |
| purge_roster_source | clean | |

24 of 28 tools are clean. 4 tools carry drift: `export_data`, `log_encounter`
(two separate rows), `add_contact`, `create_followup`. That is 5 drift rows
total, matching the five already known and listed in the brief - this audit
found no additional drift beyond them.

## A near-miss that is not drift: `update_person` and `full_name`

`UpdatePersonInput extends Partial<Record<Writable, string | null>>`
(`people.ts:147`) types every writable field, including `full_name`, as
`string | null`, because `Partial<Record<...>>` applies one type to all five
fields uniformly. The schema declares `full_name` with `str(...)` (non-null)
via `personFields` (`index.ts:278`, `index.ts:121`), which looks by the
mechanical rule like a nullability mismatch.

It is not one. `updatePerson`'s field loop special-cases `full_name` and runs
it through `requireName`, which throws `invalid_input` on anything that is not
a non-empty string - including `null` - regardless of what the schema allows
(`people.ts:174-176`). So `full_name: null` already fails today, before any
schema validation exists. Enforcing the schema's `str` type does not newly
reject a call that used to work; it just moves the rejection from inside the
handler to the transport boundary, with the same outcome either way. The
other four writable fields (`preferred_name`, `job_title`, `organization`,
`notes`) are declared `nullableStr` and are genuinely nullable in both the
schema and the handler (`value ?? null`), so they carry no such wrinkle.
Recorded here so Task 3 does not "fix" this one - loosening `full_name` to
accept null would only let a call reach `requireName` and fail there instead,
which is strictly worse (a less specific error, one layer later).

## Step 4: `import_roster`'s row items

The `rows` property's schema is not built with `obj()` and therefore carries
none of that helper's guarantees. It is declared directly at
`index.ts:490-496`:

```
rows: {
  type: "array",
  description: "...",
  items: { type: "object" },
}
```

Each item's schema is a bare `{ type: "object" }` - no `properties`, no
`required`, and critically no `additionalProperties: false`. Every other
object in this codebase's schemas goes through `obj()`, which always sets
`additionalProperties: false` (`schema.ts:47`). Roster row items are the one
exception, and it reads as deliberate rather than an oversight: the codebase
otherwise treats "every declared property, closed shape" as the norm.

**What the item schema actually constrains: nothing, beyond "is an object".**
Any property name, known or unknown, passes today and will keep passing after
validation is switched on, because JSON Schema's `{ type: "object" }` with no
`properties` and no `additionalProperties: false` matches any object
regardless of its keys.

**What the handler reads from each row:** `prepareRow` (`import_state.ts:163`)
and `importRoster` (`import.ts:226-271`) read `external_row_key`, `full_name`,
`preferred_name`, `job_title`, `organization`, `email`, `role`, and `raw` by
name - exactly the fields `RosterRow` declares. But the handler does not stop
there: `JSON.stringify(row.raw ?? row)` (`import.ts:266`) stores the **entire
original row object** - including any property not named in `RosterRow` - into
the `raw_record` column whenever the caller did not supply `raw` explicitly.
So a roster row carrying arbitrary extra fields (a source's own columns that
don't map onto this schema) is not just tolerated at the boundary; its unknown
fields are captured and persisted today, by design.

`full_name` is typed as required (non-optional) in `RosterRow`, but nothing in
the schema enforces it at the argument-validation level, and the handler does
not require it there either: a row with a missing or blank `full_name` is not
rejected outright, it is reported as a per-row soft error in the result's
`errors[]` array (`import.ts:230-233`) and skipped, while the rest of the
chunk still commits. This is intentional per-row recoverability, not a gap to
close with a schema `required`.

**The decision this hands to Task 6:** do not add `properties` or
`additionalProperties: false` to the row item schema. Doing so would reject
any roster row carrying a field the schema does not enumerate, which is
exactly the shape of data this tool exists to accept from a source it does
not control - and today's handler explicitly preserves those unknown fields
in `raw_record` rather than discarding them. Tightening this schema is a
functional change to what imports are accepted, not a validation-parity fix,
and it would break real imports that work today. If Task 6 wants to validate
`full_name`'s presence at the schema level, that is a separate, narrower
change (adding `required: ["full_name"]` to the item schema) and it still
needs to preserve `additionalProperties: true` (or omit the key, its default)
so arbitrary source columns keep passing through to `raw_record`.
