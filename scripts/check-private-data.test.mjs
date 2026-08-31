import { describe, expect, it } from "vitest";
import {
  distinctiveTerms,
  extractTerms,
  findLeaks,
  parseAddedLines,
} from "./check-private-data.mjs";

const archive = (tables = {}) => ({
  manifest: { format_version: 1 },
  tables: {
    people: [],
    tags: [],
    person_contacts: [],
    roster_entries: [],
    ...tables,
  },
});

describe("extractTerms", () => {
  it("takes full_name and organization from people", () => {
    const terms = extractTerms(
      archive({
        people: [
          { full_name: "Ada Lovelace", organization: "Analytical Engines", job_title: null },
        ],
      }),
    );
    expect(terms).toContain("Ada Lovelace");
    expect(terms).toContain("Analytical Engines");
  });

  it("takes tag names", () => {
    const terms = extractTerms(
      archive({ tags: [{ name: "example-agency-dinner" }] }),
    );
    expect(terms).toContain("example-agency-dinner");
  });

  it("takes emails from roster entries and contact values", () => {
    const terms = extractTerms(
      archive({
        roster_entries: [{ full_name: "Grace Hopper", email: "grace@example.test" }],
        person_contacts: [{ value: "cell@example.test", normalized_value: null }],
      }),
    );
    expect(terms).toContain("grace@example.test");
    expect(terms).toContain("cell@example.test");
  });

  it("skips null and empty values rather than emitting them as terms", () => {
    const terms = extractTerms(
      archive({ people: [{ full_name: "Ada Lovelace", organization: null, job_title: "" }] }),
    );
    expect(terms).not.toContain(null);
    expect(terms).not.toContain("");
  });
});

describe("distinctiveTerms", () => {
  it("keeps a multi-word personal name", () => {
    expect(distinctiveTerms(["Ada Lovelace"], [])).toContain("ada lovelace");
  });

  it("keeps a hyphenated tag", () => {
    expect(distinctiveTerms(["example-agency-dinner"], [])).toContain(
      "example-agency-dinner",
    );
  });

  it("keeps an email address even though it is a single short token", () => {
    expect(distinctiveTerms(["a@b.co"], [])).toContain("a@b.co");
  });

  it("drops generic single words that belong in a codebase", () => {
    const kept = distinctiveTerms(["ruby", "rails", "saas", "drupal", "speaker"], []);
    expect(kept).toHaveLength(0);
  });

  it("drops an allowlisted term regardless of case", () => {
    expect(distinctiveTerms(["Widgetworks"], ["widgetworks"])).toHaveLength(0);
  });
});

describe("parseAddedLines", () => {
  const diff = [
    "diff --git a/docs/NOTES.md b/docs/NOTES.md",
    "--- a/docs/NOTES.md",
    "+++ b/docs/NOTES.md",
    "@@ -10,0 +11,2 @@",
    "+first added line",
    "+second added line",
    "-a removed line",
    " context line",
  ].join("\n");

  it("returns only added lines, with their file and line number", () => {
    expect(parseAddedLines(diff)).toEqual([
      { file: "docs/NOTES.md", line: 11, text: "first added line" },
      { file: "docs/NOTES.md", line: 12, text: "second added line" },
    ]);
  });

  it("does not mistake the +++ header for an added line", () => {
    expect(parseAddedLines(diff).map((a) => a.text)).not.toContain(
      "+ b/docs/NOTES.md",
    );
  });
});

describe("findLeaks", () => {
  const added = [{ file: "docs/M.md", line: 3, text: "spoke to Ada Lovelace today" }];

  it("reports the term, file, and line when a term appears", () => {
    expect(findLeaks(added, ["ada lovelace"])).toEqual([
      { file: "docs/M.md", line: 3, term: "ada lovelace" },
    ]);
  });

  it("matches regardless of case", () => {
    expect(findLeaks([{ file: "f", line: 1, text: "ADA LOVELACE" }], ["ada lovelace"]))
      .toHaveLength(1);
  });

  it("returns nothing for a clean diff", () => {
    expect(findLeaks(added, ["grace hopper"])).toHaveLength(0);
  });

  it("does not fire on a term embedded in a longer word", () => {
    const lines = [{ file: "f", line: 1, text: "the widgetworksuite protocol" }];
    expect(findLeaks(lines, ["widgetworks"])).toHaveLength(0);
  });
});
