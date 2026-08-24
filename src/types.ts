export interface Person {
  id: string;
  record_kind: "person";
  full_name: string;
  preferred_name: string | null;
  job_title: string | null;
  organization: string | null;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  contact_type: "email" | "phone";
  value: string;
  label: string | null;
}

export interface Link {
  id: string;
  link_type: string;
  url: string;
}

/**
 * Provenance METADATA, which is all `getPerson` ever returns.
 *
 * `person_sources` also stores `raw_record_snapshot`, and it is deliberately
 * absent from this type. Imported roster text is written by strangers and read
 * back to an agent that can call write tools; returning it from `getPerson`
 * would put attacker-controlled text into the context window immediately before
 * every write against that person. The snapshot is reachable only through the
 * CLI export in plan 3.
 */
export interface Source {
  id: string;
  source_key: string;
  external_row_key: string;
  /** Copied at promotion time, so it survives the source being relabelled. */
  source_label: string;
  source_event: string | null;
  source_url: string;
  source_captured_at: string;
  /** The hash of what was captured, so a caller can compare without the text. */
  content_hash_at_promotion: string;
  /**
   * Whether the staged row still matches what was promoted. True when the
   * current `roster_entries.content_hash` equals `content_hash_at_promotion`, false when
   * the row has changed since, and null when the staged row is gone - purged,
   * or never re-imported. Null is a third state rather than false because
   * "changed" and "no longer there" call for different next moves.
   */
  matches_current: boolean | null;
  promoted_at: string;
}

export interface Encounter {
  id: string;
  record_kind: "encounter";
  person_id: string;
  occurred_on: string;
  occurred_at: string | null;
  location: string | null;
  event: string | null;
  summary: string;
  created_at: string;
}

export interface Followup {
  id: string;
  record_kind: "followup";
  person_id: string;
  due_on: string;
  note: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

export interface PersonDetail extends Person {
  contacts: Contact[];
  links: Link[];
  tags: string[];
  sources: Source[];
  open_followups: Followup[];
  recent_encounters: Encounter[];
  encounter_count: number;
  encounter_next_cursor: string | null;
}
