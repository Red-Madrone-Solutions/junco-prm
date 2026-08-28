import type { ToolContext } from "../context";
import { envelope } from "../context";
import { addContact, addLink, addTags, removeContact, removeLink, removeTags } from "./attributes";
import { deleteEncounter, listEncounters, logEncounter, updateEncounter } from "./encounters";
import { listRecords } from "./export";
import {
  cancelFollowup,
  completeFollowup,
  createFollowup,
  listDue,
  updateFollowup,
} from "./followups";
import { finalizeImport, importRoster } from "./import";
import {
  archivePerson,
  createPerson,
  deletePerson,
  getPerson,
  unarchivePerson,
  updatePerson,
} from "./people";
import { promoteRosterEntry } from "./promote";
import { getRosterEntry, listRosterSources, purgeRosterSource } from "./roster_admin";
import {
  bool,
  enumOf,
  id,
  int,
  nullableStr,
  obj,
  str,
  strArray,
  type JsonSchema,
} from "./schema";
import { searchPeople } from "./search";
import { searchRosterEntries } from "./search_roster";

/**
 * MCP's three static annotations. Clients use them to decide what to approve
 * and what to run without asking, so a surface this size should not make a
 * client guess.
 *
 * `readOnlyHint` - writes nothing, ever.
 * `destructiveHint` - removes or overwrites data a user would miss. An UPDATE
 *   counts; an INSERT does not.
 * `idempotentHint` - calling it twice with the same input has the same effect
 *   as calling it once, WITHOUT relying on an idempotency_key. Every write here
 *   accepts a key, so the key is not what this hint is about: `add_tags` is
 *   idempotent by nature, `log_encounter` is not.
 */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

/** Every read tool. Written once so 7 tools cannot disagree about it. */
const READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

/**
 * A write that ADDS without removing or overwriting, and is safe to replay.
 * A write that replaces a value a user wrote is DESTRUCTIVE by the rule above,
 * whether or not it also deletes a row.
 */
const WRITE_IDEMPOTENT: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

/** A write that creates a new record each time it is called. */
const WRITE_CREATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
};

/** Removes or overwrites data a user would miss. */
const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
};

export interface ToolDefinition {
  name: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: JsonSchema;
  run(ctx: ToolContext, input: never): Promise<unknown>;
}

function define<I>(
  name: string,
  description: string,
  annotations: ToolAnnotations,
  inputSchema: JsonSchema,
  run: (ctx: ToolContext, input: I) => Promise<unknown>
): ToolDefinition {
  // Every result goes through `envelope`, which adds the current date in the
  // owner's time zone. It is applied HERE rather than inside each tool so no
  // tool can forget it: the previous draft made that decision 26 times and got
  // it right once, in listDue.
  const wrapped = async (ctx: ToolContext, input: never) => {
    const result = await run(ctx, input as I);
    // Every tool returns a plain object. The array and primitive branches are a
    // backstop that should never fire, and they throw rather than silently
    // reshaping the result into `{ result: ... }` - which is what the previous
    // draft did, giving `list_roster_sources` alone a different response shape
    // from all 27 others with nothing documenting it.
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(
        `${name} returned a ${Array.isArray(result) ? "array" : typeof result}; ` +
          "every tool must return an object so the envelope can add `today` at the top level"
      );
    }
    return envelope(ctx, result as object);
  };
  return { name, description, annotations, inputSchema, run: wrapped };
}

const personId = id("p", "Person");
const personFields = {
  full_name: str("Full name as written."),
  preferred_name: nullableStr("What they go by, if different."),
  job_title: nullableStr("Job title."),
  organization: nullableStr("Organization, as plain text."),
  notes: nullableStr(
    "Standing facts that stay true between meetings: a dietary restriction, who introduced you, what they care about. What happened on a particular day goes in log_encounter instead."
  ),
};

/**
 * NULL PROTOTYPE, and it is load-bearing rather than tidy. Plan 2's transport
 * will index this map by a tool name that arrives over the wire. As a plain
 * object, `TOOLS["toString"]` resolves up the prototype chain to a function,
 * and any `=== undefined` guard on the lookup passes. The same shape was a live
 * defect in `export.ts`'s QUERIES: `list_records({scope: "toString"})` (then
 * still named `export_data`) fed `Function.prototype.toString`'s source text
 * into the SQL and returned a raw D1 error carrying no `code`. `Object.keys`
 * and `for...in` are unaffected.
 */
export const TOOLS: Record<string, ToolDefinition> = Object.assign(
  Object.create(null),
  Object.fromEntries(
  [
    // ---------------------------------------------------------------- reads
    define(
      "search_people",
      "Search people you have recorded. Matches names, organization, title, " +
        "notes, tags, and email addresses. Returns durable records you can write to. " +
        "For staged roster entries, use search_roster_entries instead.",
      READ,
      obj(
        {
          query: str("Search text. Treated as literal text, never as query syntax."),
          include_archived: bool("Include archived people. Defaults to false."),
          limit: int("Maximum results, 1 to 50. Defaults to 20."),
          cursor: str("Page token from a previous next_cursor."),
        },
        ["query"]
      ),
      searchPeople
    ),
    define(
      "search_roster_entries",
      "Free-text search over staged roster entries: names, organizations, and job titles. " +
        "Returns external_row_key, the identity the import assigned each row, so a source row " +
        "can be matched back to its entry. NOTE: when no source id was supplied at import, that " +
        "key is derived from the person's email address and therefore contains it. " +
        "For filtering by role or promotion state rather than text, use list_roster_entries.",
      READ,
      obj(
        {
          query: str("Search text. Treated as literal text, never as query syntax."),
          limit: int("Maximum results, 1 to 50. Defaults to 20."),
          cursor: str("Page token from a previous next_cursor."),
        },
        ["query"]
      ),
      searchRosterEntries
    ),
    define(
      "get_person",
      "Fetch one person with contacts, links, tags, provenance metadata, open follow-ups, " +
        "and recent encounters.",
      READ,
      obj(
        {
          person_id: personId,
          encounter_limit: int("How many recent encounters to include. Defaults to 10."),
          encounter_cursor: str("Page token from a previous encounter_next_cursor."),
        },
        ["person_id"]
      ),
      getPerson
    ),
    define(
      "list_encounters",
      "List encounters by person, event, or date range, newest first.",
      READ,
      obj({
        person_id: personId,
        event: str("Event name to filter by."),
        since: str("Earliest occurred_on, as YYYY-MM-DD."),
        until: str("Latest occurred_on, as YYYY-MM-DD."),
        limit: int("Page size, 1 to 100. Defaults to 20."),
        cursor: str("Page token from a previous next_cursor."),
      }),
      listEncounters
    ),
    define(
      "list_due",
      "List open follow-ups, most overdue first, in the owner's time zone.",
      READ,
      obj({
        through: str("Include follow-ups due on or before this YYYY-MM-DD. Defaults to today."),
        limit: int("Page size. Defaults to 50."),
        cursor: str("Page token from a previous next_cursor."),
      }),
      listDue
    ),
    define(
      "list_roster_sources",
      "List imported rosters: how many entries each holds, how many the latest import still " +
        "contains, how many it no longer lists, how many have been promoted to people, and " +
        "when it was last imported.",
      READ,
      obj({}),
      listRosterSources
    ),
    define(
      "get_roster_entry",
      "Read one staged roster row: the imported fields, where it came from, whether the " +
        "latest import still lists it, and whether it has already been promoted to a person." +
        " Provenance records carry external_row_key with a tier prefix showing how identity was " +
        "derived: 'k:' plus the source's own row id when the import supplied one, else 'e:' plus " +
        "the normalized email, else 'h:' plus a hash of name and organization. Stability follows " +
        "the tier: a k: key is as stable as the source id, an e: key changes if the email " +
        "changes, an h: key changes if the name or organization changes.",
      READ,
      obj({ roster_entry_id: id("re", "Roster entry") }, ["roster_entry_id"]),
      getRosterEntry
    ),
    define(
      "list_records",
      "List durable records a page at a time, filtered by scope. Use this to read back what is " +
        "in Junco: all people, all encounters, or all open follow-ups. For one person with their " +
        "tags, links, and contacts, use get_person. This is not the backup; backup and restore " +
        "are run from the command line and are documented in docs/BACKUP.md.",
      READ,
      obj(
        {
          scope: enumOf(["people", "encounters", "followups"], "Which records to return."),
          archived: bool("Include archived people. People scope only. Defaults to false."),
          updated_after: str(
            "ISO instant. Returns only records updated strictly after it, so a watermark can be " +
              "passed straight back. Deletions are not reported: a deleted record is simply absent " +
              "from a full listing."
          ),
          // export.ts's own MAX_LIMIT is 500, not 200 - clampLimit there throws
          // limit_exceeded above it. The description states the real ceiling
          // rather than the plan's draft figure, since a client reads this
          // string to decide what to send.
          limit: int("Page size, 1 to 500. Defaults to 100."),
          cursor: str("Page token from a previous next_cursor."),
          include: strArray(
            'Relations to return inline on people. Any of "tags", "links", "contacts". ' +
              "Page size is capped at 100 when this is used."
          ),
        },
        []
      ),
      listRecords
    ),

    // --------------------------------------------------------------- writes
    define(
      "create_person",
      "Create a person. Refuses when the name and organization, or the email, closely match " +
        "someone already recorded or a staged roster row, and returns those candidates instead; " +
        "promote the roster row to keep its provenance, or pass force: true to create a " +
        "separate record anyway.",
      WRITE_CREATES,
      obj(
        {
          ...personFields,
          email: str("Optional. Used only to check for duplicates; add_contact stores it."),
          force: bool("Create even on a close match. Defaults to false."),
        },
        ["full_name"],
        { idempotent: true }
      ),
      createPerson
    ),
    define(
      "update_person",
      "Update a person's scalar fields. Does not touch contacts, links, or tags; those have " +
        "their own tools.",
      // DESTRUCTIVE, not WRITE_IDEMPOTENT, and the difference is what a client
      // decides to run without asking. MCP defines destructiveHint: false as
      // "performs only additive updates". This overwrites `notes` - standing
      // facts the user wrote, gone with nothing retaining them - so a client
      // told the call is additive can auto-approve destroying them.
      DESTRUCTIVE,
      obj({ person_id: personId, ...personFields }, ["person_id"], { idempotent: true }),
      updatePerson
    ),
    define(
      "archive_person",
      "Hide a person from search without deleting anything.",
      WRITE_IDEMPOTENT,
      obj({ person_id: personId }, ["person_id"], { idempotent: true }),
      archivePerson
    ),
    define(
      "unarchive_person",
      "Restore an archived person to search.",
      WRITE_IDEMPOTENT,
      obj({ person_id: personId }, ["person_id"], { idempotent: true }),
      unarchivePerson
    ),
    define(
      "delete_person",
      "Permanently delete a person and everything attached to them. Two calls: the first " +
        "returns a preview and a confirmation_token, the second presents that token. " +
        "Archiving is almost always what you want instead.",
      DESTRUCTIVE,
      obj(
        {
          person_id: personId,
          confirmation_token: str("The token from the preview call. Omit to get a preview."),
        },
        ["person_id"],
        { idempotent: true }
      ),
      deletePerson
    ),
    define(
      "add_contact",
      "Add an email address or phone number to a person.",
      WRITE_IDEMPOTENT,
      obj(
        {
          person_id: personId,
          contact_type: enumOf(["email", "phone"], "Which kind of contact method."),
          value: str("The address or number, as the person gave it."),
          label: nullableStr('Optional, e.g. "work" or "mobile".'),
        },
        ["person_id", "contact_type", "value"],
        { idempotent: true }
      ),
      addContact
    ),
    define(
      "remove_contact",
      "Remove one contact method from a person.",
      DESTRUCTIVE,
      obj({ person_id: personId, contact_id: id("pc", "Contact") }, ["person_id", "contact_id"], {
        idempotent: true,
      }),
      removeContact
    ),
    define(
      "add_link",
      "Add a website or social profile to a person.",
      WRITE_IDEMPOTENT,
      obj(
        {
          person_id: personId,
          link_type: str('What kind of link, e.g. "website", "mastodon", "linkedin".'),
          url: str("The full URL."),
        },
        ["person_id", "link_type", "url"],
        { idempotent: true }
      ),
      addLink
    ),
    define(
      "remove_link",
      "Remove one link from a person.",
      DESTRUCTIVE,
      obj({ person_id: personId, link_id: id("pl", "Link") }, ["person_id", "link_id"], {
        idempotent: true,
      }),
      removeLink
    ),
    define(
      "add_tags",
      "Add tags to a person without touching the tags already there.",
      WRITE_IDEMPOTENT,
      obj({ person_id: personId, tags: strArray("Tag names to add.") }, ["person_id", "tags"], {
        idempotent: true,
      }),
      addTags
    ),
    define(
      "remove_tags",
      "Remove specific tags from a person, leaving the rest in place.",
      DESTRUCTIVE,
      obj({ person_id: personId, tags: strArray("Tag names to remove.") }, ["person_id", "tags"], {
        idempotent: true,
      }),
      removeTags
    ),
    define(
      "log_encounter",
      "Record that you met or spoke with someone: when, where, and what happened. " +
        "For what happened on a particular day. Standing facts that stay true between " +
        "meetings belong in the person's notes instead.",
      WRITE_CREATES,
      // NOT `followup_due_on` / `followup_note`, despite the spec listing
      // "optional follow-up" for this tool: logEncounter (src/tools/encounters.ts,
      // shipped by an earlier task) reads only person_id, occurred_on, summary,
      // occurred_at, location, event, and idempotency_key. Advertising fields it
      // silently ignores would be a worse contract than a narrower true one - see
      // the task 16 report for the recommendation to close this in encounters.ts.
      obj(
        {
          person_id: personId,
          occurred_on: str("The date it happened, as YYYY-MM-DD in the owner's time zone."),
          // DECLARED BECAUSE THE CODE HONOURS IT. logEncounter validates
          // occurred_at as an ISO instant and writes it to a column migration
          // 0005 declares, but this schema omitted it while declaring
          // additionalProperties: false. Nothing enforces the schema today, so
          // it worked; the moment plan 2's transport validates against these
          // schemas, the column would have become permanently unwritable.
          occurred_at: nullableStr(
            "Optional exact instant, ISO-8601 UTC, when the time of day matters. The date above is what reads sort by."
          ),
          summary: str("What happened."),
          location: nullableStr("Where, if worth recording."),
          event: nullableStr('Event name, e.g. "WordCamp US 2026".'),
        },
        ["person_id", "summary"],
        { idempotent: true }
      ),
      logEncounter
    ),
    define(
      "update_encounter",
      "Correct a mis-logged encounter.",
      // DESTRUCTIVE for the same reason as update_person: it overwrites
      // `summary`, which is the whole content of the record.
      DESTRUCTIVE,
      obj(
        {
          encounter_id: id("enc", "Encounter"),
          occurred_on: str("Corrected date, as YYYY-MM-DD."),
          // Same reason as log_encounter's; see the comment there.
          occurred_at: nullableStr(
            "Corrected exact instant, ISO-8601 UTC, or null to clear it."
          ),
          summary: str("Corrected summary."),
          location: nullableStr("Corrected location, or null to clear it."),
          event: nullableStr("Corrected event, or null to clear it."),
        },
        ["encounter_id"],
        { idempotent: true }
      ),
      updateEncounter
    ),
    define(
      "delete_encounter",
      "Erase an encounter. Deletes in one call, deliberately, so a mistake just dictated can " +
        "be removed without a second round trip.",
      DESTRUCTIVE,
      obj({ encounter_id: id("enc", "Encounter") }, ["encounter_id"], { idempotent: true }),
      deleteEncounter
    ),
    define(
      "create_followup",
      "Record something you owe a person, due on a date. A person may owe several things at " +
        "once; this adds one rather than replacing what is already open.",
      WRITE_CREATES,
      obj(
        {
          person_id: personId,
          due_on: str("Due date, as YYYY-MM-DD in the owner's time zone."),
          note: nullableStr("What is owed."),
        },
        ["person_id", "due_on"],
        { idempotent: true }
      ),
      createFollowup
    ),
    define(
      "complete_followup",
      "Mark a follow-up done.",
      WRITE_IDEMPOTENT,
      obj({ followup_id: id("fu", "Follow-up") }, ["followup_id"], { idempotent: true }),
      completeFollowup
    ),
    define(
      "cancel_followup",
      "Drop a follow-up without doing it.",
      WRITE_IDEMPOTENT,
      obj({ followup_id: id("fu", "Follow-up") }, ["followup_id"], { idempotent: true }),
      cancelFollowup
    ),
    define(
      "update_followup",
      "Change an open follow-up's note or due date. Send note or due_on or both; " +
        "send note as null to clear it. A completed or cancelled follow-up cannot be " +
        "edited, because a closed follow-up is a record of what happened.",
      // DESTRUCTIVE, not WRITE_IDEMPOTENT, for the same reason as update_person
      // and update_encounter: it overwrites a note the user wrote and nothing
      // retains the previous text. A client using these hints to decide what
      // to run without asking would otherwise auto-approve destroying a note.
      DESTRUCTIVE,
      obj(
        {
          followup_id: id("fu", "Follow-up"),
          note: nullableStr("Replaces the existing note. Null clears it."),
          due_on: str("New due date, YYYY-MM-DD."),
        },
        ["followup_id"],
        { idempotent: true }
      ),
      updateFollowup
    ),
    define(
      "import_roster",
      "Import one chunk of an attendee or speaker roster. Send parsed row objects, not raw " +
        "CSV text. The first call declares expected_total and carries the first chunk; every " +
        "later call carries run_id, the offset it continues from, and only its own rows. Loop " +
        "until remaining is zero, then call finalize_import." +
        " This returns counts, not entry ids, and no call maps a source row to the re_ id it " +
        "created. Plan an import knowing that, rather than discovering it after the rows are " +
        "staged.",
      WRITE_IDEMPOTENT,
      obj(
        {
          source_key: str("Stable key for this roster, e.g. 'wcus-2026-attendees'."),
          label: str("Human-readable name for this roster."),
          event: str("Event this roster belongs to."),
          source_url: str("Where the roster was fetched from."),
          format: enumOf(["csv", "json", "text"], "What the rows were parsed from."),
          rows: {
            type: "array",
            description:
              "Parsed rows for THIS chunk only. Each may carry external_row_key, full_name, " +
              "preferred_name, job_title, organization, email, role, and raw.",
            items: { type: "object" },
          },
          expected_total: int("Total rows this run will send. Required on the first call."),
          run_id: id("ir", "Import run"),
          offset: int("Rows already sent in this run. Must equal the run's next_offset."),
        },
        ["source_key", "label", "source_url", "format", "rows"],
        { idempotent: true }
      ),
      importRoster
    ),
    define(
      "finalize_import",
      "Mark an import run complete. Destroys nothing. Until a run is finalized it does not " +
        "become the baseline that tells you which roster rows the latest import still lists.",
      WRITE_IDEMPOTENT,
      obj({ run_id: id("ir", "Import run") }, ["run_id"], { idempotent: true }),
      finalizeImport
    ),
    define(
      "promote_roster_entry",
      "Turn a staged roster row into a person you have actually engaged with, keeping its " +
        "provenance. Call it with only roster_entry_id to see duplicate candidates without " +
        "writing anything, then call it again with link_to_person_id or create_new: true." +
        " If the roster row carries an email, this call stores it as a person contact. That " +
        "differs from create_person, whose email is used for duplicate detection only and is not " +
        "stored. Calling add_contact afterwards with the same address is a no-op rather than a " +
        "duplicate, because contacts are unique per person, type, and normalized value.",
      WRITE_IDEMPOTENT,
      obj(
        {
          roster_entry_id: id("re", "Roster entry"),
          link_to_person_id: personId,
          create_new: bool("Create a new person from this row."),
          expected_content_hash: str("The content_hash from the preview call, if you made one."),
        },
        ["roster_entry_id"],
        { idempotent: true }
      ),
      promoteRosterEntry
    ),
    define(
      "purge_roster_source",
      "Delete a roster's staged entries. Two calls: the first returns a preview and a " +
        "confirmation_token, the second presents that token. People already promoted from " +
        "this roster, and their provenance, are untouched.",
      DESTRUCTIVE,
      obj(
        {
          roster_source_id: id("rs", "Roster source"),
          confirmation_token: str("The token from the preview call. Omit to get a preview."),
        },
        ["roster_source_id"],
        { idempotent: true }
      ),
      purgeRosterSource
    ),
  ].map((tool) => [tool.name, tool])
  )
);

/** Every tool name, so a caller can assert coverage without reaching into the map. */
export const TOOL_NAMES = Object.keys(TOOLS);
