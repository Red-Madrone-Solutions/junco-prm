/**
 * PINNED RULES. Do not edit without a major version bump and a documented re-key.
 *
 * Every `external_row_key` in every deployed instance is a function of this
 * module. There is no migration that can recompute them: the rosters they came
 * from may no longer exist. Changing a rule here orphans keys that are the only
 * link between a person and where they came from.
 */

/** Canonical form for any free text taking part in a key or a hash. */
export function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Known honorifics only. A comma suffix that is not on this list is part of the
 * name - "Lovelace, Ada" is surname-first, and stripping it would merge two
 * different people. At most one suffix is removed, so "Ada Lovelace, PhD, MBA"
 * loses only the MBA.
 */
export const HONORIFIC_SUFFIXES: ReadonlySet<string> = new Set([
  "jr", "sr", "ii", "iii", "iv", "v",
  "phd", "ph.d", "md", "m.d", "dds", "dvm", "esq", "esquire",
  "mba", "ma", "ms", "msc", "ba", "bsc", "bs", "jd", "rn", "cpa", "pe",
]);

export function normalizeName(value: string): string {
  const text = normalizeText(value);
  const comma = text.lastIndexOf(",");
  if (comma === -1) return text;
  const suffix = text.slice(comma + 1).trim().replace(/\.$/, "");
  if (!HONORIFIC_SUFFIXES.has(suffix)) return text;
  return text.slice(0, comma).trim();
}

/**
 * Lowercase the whole address, local part included, and do NOT strip
 * plus-addressing. `ada+wcus@example.test` may be a different person's mailbox
 * alias; the cost of merging two people is higher than the cost of two rows.
 */
export function normalizeEmail(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

/**
 * NOT one of the pinned rules, and the difference matters.
 *
 * No `external_row_key` is ever derived from a phone number, so changing this
 * function later re-normalizes `person_contacts.normalized_value` with a
 * migration and nothing is orphaned. It lives in this module for proximity, not
 * because it carries the same permanence.
 *
 * Digits and an optional leading `+`. Deliberately not a full E.164 parse:
 * that needs a region to resolve a national number, this system has no country
 * for a person, and guessing one silently merges or splits contacts.
 */
export function normalizePhone(value: string): string {
  const trimmed = value.normalize("NFKC").trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

/** UTF-8 canonical JSON: object keys sorted, arrays left in order. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A row after every field has been through the rules above. */
export interface NormalizedRow {
  full_name: string;
  organization?: string;
  email?: string;
  [field: string]: string | undefined;
}

/**
 * The identity key, in three tiers, EACH ONE NAMESPACED BY A PREFIX.
 *
 * `k:` the source's own row id, `e:` the normalized email, `h:` a digest of
 * normalized name plus organization. It is never the name alone: the reference
 * roster carries 11 duplicated names across 23 rows.
 *
 * Tier 3 uses a STABLE IDENTITY SUBSET - normalized name and organization and
 * nothing else - rather than the whole row. A whole-row hash makes an edited
 * row a new row, so the edit is undetectable by construction, a duplicate lands
 * beside the stale original, and promotion finds no prior provenance.
 *
 * THE PREFIXES ARE NOT DECORATION, and they cannot be added later - every key
 * in every deployed instance would be orphaned. They buy two things:
 *
 * 1. A TIER TRANSITION BECOMES DETECTABLE. A roster that gains email addresses
 *    between two exports moves every row from tier 3 to tier 2, which re-keys
 *    the whole roster and silently duplicates it. Adding emails to an export is
 *    an ordinary thing for a conference to do. Unprefixed, the second import
 *    just produces a parallel set of rows and the originals go stale beside
 *    them, with nothing said. Prefixed, Task 12b can compare tiers and report
 *    "42 rows changed identity tier" instead. It does not PREVENT the
 *    duplication - only aliasing would, and that was considered and rejected as
 *    too much machinery for the hardest part of the schema - but a visible
 *    duplication an operator can act on beats an invisible one.
 * 2. A COLLISION BETWEEN TIERS BECOMES IMPOSSIBLE. Unprefixed, a source that
 *    emits `ada@example.test` as its own row id collides with a different row
 *    whose email-derived key is the same string. Rare, silent, and a merge of
 *    two different people.
 *
 * The costs are worth stating: keys are two characters longer, and
 * `person_sources.external_row_key` still carries a live email address in tier
 * 2, which the CLI export in plan 3 will emit. That is PII in a key column and
 * the export documentation has to say so.
 */
export async function externalRowKey(
  row: NormalizedRow,
  sourceRowId: string | undefined
): Promise<string> {
  if (sourceRowId && sourceRowId.trim() !== "") return `k:${sourceRowId.trim()}`;
  if (row.email && row.email !== "") return `e:${row.email}`;
  return `h:${await sha256Hex(
    canonicalJson({ full_name: row.full_name, organization: row.organization ?? null })
  )}`;
}

/**
 * Which tier produced a key. Import uses it to detect a TIER TRANSITION, which
 * is otherwise invisible and duplicates rows.
 */
export function keyTier(key: string): "source" | "email" | "hash" | "unknown" {
  if (key.startsWith("k:")) return "source";
  if (key.startsWith("e:")) return "email";
  if (key.startsWith("h:")) return "hash";
  return "unknown";
}

/**
 * The change-detection hash: the whole normalized row. Recomputed on every
 * import, and compared at promotion time so a commit cannot promote a person
 * from data the caller never inspected.
 *
 * Looser parameter type than `externalRowKey`'s on purpose: this hashes the
 * whole row and reads no particular field, whereas `externalRowKey` reads
 * name and organization specifically.
 */
export async function contentHash(row: Record<string, string | undefined>): Promise<string> {
  return sha256Hex(canonicalJson(row));
}
