import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  contentHash,
  externalRowKey,
  keyTier,
  normalizeEmail,
  normalizeName,
  normalizeText,
  sha256Hex,
} from "../src/normalize";

describe("normalizeText", () => {
  it("trims and collapses internal whitespace runs", () => {
    expect(normalizeText("  Ada   Lovelace \t ")).toBe("ada lovelace");
  });

  it("applies NFKC so compatibility forms fold together", () => {
    // U+FF21 FULLWIDTH LATIN CAPITAL LETTER A folds to "a" under NFKC + lowercase.
    expect(normalizeText("Ａda")).toBe("ada");
  });

  it("lowercases without a locale, so a Turkish locale cannot change the result", () => {
    // toLocaleLowerCase("tr") would map I to a dotless i. toLowerCase must not.
    expect(normalizeText("INSTITUTE")).toBe("institute");
  });
});

describe("normalizeName", () => {
  it("strips a known trailing honorific suffix", () => {
    expect(normalizeName("Ada Lovelace, PhD")).toBe("ada lovelace");
  });

  it("leaves an unknown comma suffix alone", () => {
    // "Lovelace, Ada" is a surname-first name, not an honorific. Stripping it
    // would silently make two different people into one.
    expect(normalizeName("Lovelace, Ada")).toBe("lovelace, ada");
  });

  it("strips at most one suffix", () => {
    expect(normalizeName("Ada Lovelace, PhD, MBA")).toBe("ada lovelace, phd");
  });
});

describe("normalizeEmail", () => {
  it("lowercases the whole address", () => {
    expect(normalizeEmail("Ada@Example.TEST")).toBe("ada@example.test");
  });

  it("does NOT strip plus-addressing", () => {
    // ada+wcus@ may be a different person's mailbox alias. The cost of merging
    // two people is higher than the cost of carrying two rows.
    expect(normalizeEmail("ada+wcus@example.test")).toBe("ada+wcus@example.test");
  });
});

describe("canonicalJson", () => {
  it("sorts object keys so two orderings hash the same", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("sorts nested keys too", () => {
    expect(canonicalJson({ x: { b: 1, a: 2 } })).toBe('{"x":{"a":2,"b":1}}');
  });

  it("does not sort arrays, because order is meaning there", () => {
    expect(canonicalJson([2, 1])).toBe("[2,1]");
  });
});

describe("externalRowKey", () => {
  const row = {
    full_name: "ada lovelace",
    organization: "analytical society",
    email: "ada@example.test",
    job_title: "programmer",
  };

  it("prefers the source's own row identifier, namespaced", async () => {
    expect(await externalRowKey(row, "row-7")).toBe("k:row-7");
  });

  it("falls back to the normalized email when the source has no key", async () => {
    expect(await externalRowKey(row, undefined)).toBe("e:ada@example.test");
  });

  it("falls back to a hash of name plus organization when there is no email", async () => {
    const keyless = { ...row, email: undefined };
    const key = await externalRowKey(keyless, undefined);
    expect(key).toBe(
      `h:${await sha256Hex(
        canonicalJson({ full_name: "ada lovelace", organization: "analytical society" })
      )}`
    );
  });

  it("NEVER lets one tier's key collide with another's", async () => {
    // A source that emits an email address as its own row id. Unprefixed, this
    // is the same string as the tier-2 key for a different row, and two
    // different people merge silently.
    const sourceIdIsAnEmail = await externalRowKey(
      { full_name: "someone else", organization: "elsewhere" },
      "ada@example.test"
    );
    const derivedFromEmail = await externalRowKey(row, undefined);
    expect(sourceIdIsAnEmail).not.toBe(derivedFromEmail);
    expect(sourceIdIsAnEmail).toBe("k:ada@example.test");
    expect(derivedFromEmail).toBe("e:ada@example.test");
  });

  it("reports which tier produced a key", async () => {
    expect(keyTier(await externalRowKey(row, "row-7"))).toBe("source");
    expect(keyTier(await externalRowKey(row, undefined))).toBe("email");
    expect(keyTier(await externalRowKey({ ...row, email: undefined }, undefined))).toBe("hash");
  });

  it("shows the tier CHANGING when a roster gains an email between exports", async () => {
    // The case the prefixes exist for. A conference adds emails to its export;
    // every row re-keys, the roster duplicates, and unprefixed nothing can tell
    // that this is what happened. This does not prevent it - Task 12b reports
    // it, and an operator decides.
    const august = { full_name: "ada lovelace", organization: "kinsta" };
    const september = { ...august, email: "ada@example.test" };

    const before = await externalRowKey(august, undefined);
    const after = await externalRowKey(september, undefined);

    expect(before).not.toBe(after);
    expect(keyTier(before)).toBe("hash");
    expect(keyTier(after)).toBe("email");
  });

  it("is STABLE when a field outside the identity subset changes", async () => {
    // This is the case the previous key design broke. A corrected job title
    // must not produce a new row; it must produce a changed content_hash.
    const keyless = { ...row, email: undefined };
    const corrected = { ...keyless, job_title: "senior programmer" };
    expect(await externalRowKey(corrected, undefined)).toBe(
      await externalRowKey(keyless, undefined)
    );
  });

  it("distinguishes two people with the same name at different organizations", async () => {
    const a = { full_name: "ada lovelace", organization: "kinsta", email: undefined };
    const b = { full_name: "ada lovelace", organization: "automattic", email: undefined };
    expect(await externalRowKey(a, undefined)).not.toBe(await externalRowKey(b, undefined));
  });

  it("collides two people with the same name at the same organization, knowingly", async () => {
    // The spec concedes this. It is rare, it is visible as a duplicate when it
    // happens, and every alternative makes ordinary re-imports worse. The test
    // exists so that nobody later reads the collision as a bug.
    const a = { full_name: "ada lovelace", organization: "kinsta", email: undefined };
    const b = { full_name: "ada lovelace", organization: "kinsta", email: undefined };
    expect(await externalRowKey(a, undefined)).toBe(await externalRowKey(b, undefined));
  });
});

describe("contentHash", () => {
  it("CHANGES when any field changes, including one outside the identity subset", async () => {
    const before = { full_name: "ada lovelace", job_title: "programmer" };
    const after = { full_name: "ada lovelace", job_title: "senior programmer" };
    expect(await contentHash(before)).not.toBe(await contentHash(after));
  });

  it("is stable across key ordering", async () => {
    expect(await contentHash({ a: "1", b: "2" })).toBe(await contentHash({ b: "2", a: "1" }));
  });
});
