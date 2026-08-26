import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertOwner, NotOwnerError } from "../src/auth/authorize";
import type { Config } from "../src/config";

const config: Config = {
  githubClientId: "Iv1.abc",
  githubClientSecret: "shhh",
  cookieKey: "0".repeat(64),
  ownerGithubUserId: "583231",
  ownerTimezone: "UTC",
};

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Every refusal must be pinned to its reason, not only its error class: a
// mutation that keeps throwing NotOwnerError for the wrong reason has to
// fail a test, not just pass one that stops at toThrow.
function refusalReason(props: unknown): "no_props" | "not_owner" {
  try {
    assertOwner(config, props, "r1");
  } catch (err) {
    if (err instanceof NotOwnerError) return err.reason;
    throw err;
  }
  throw new Error("expected assertOwner to throw NotOwnerError");
}

describe("assertOwner", () => {
  it("accepts the owner", () => {
    expect(assertOwner(config, { githubUserId: "583231" }, "r1")).toBe("583231");
  });

  it("REFUSES a valid grant belonging to a different GitHub account", () => {
    // The spec calls this test non-negotiable. The token is genuine and the
    // provider validated it; the person behind it is not the owner.
    expect(() => assertOwner(config, { githubUserId: "999999" }, "r1")).toThrow(NotOwnerError);
  });

  it("REFUSES every shape of missing props", () => {
    // The fail-open a defensive reflex introduces is
    // `if (props?.githubUserId && props.githubUserId !== owner) throw`,
    // which lets a grant with NO props straight through. Every shape here
    // must land on no_props specifically, not merely throw: a guard that
    // still throws but reports not_owner is a broken diagnostic, not a
    // passing test.
    const shapes: Array<[string, unknown]> = [
      ["null", null],
      ["undefined", undefined],
      ["{}", {}],
      ["{ githubUserId: null }", { githubUserId: null }],
      ['"583231"', "583231"],
      ['["583231"]', ["583231"]],
      ["583231", 583231],
    ];
    for (const [label, props] of shapes) {
      expect(refusalReason(props), label).toBe("no_props");
    }
  });

  it("REFUSES a numeric id that only differs by type", () => {
    // Props round-trip through JSON in KV. A number that was stored as a number
    // must not pass a comparison written for strings, and must not silently
    // coerce either - it means the write path changed and should be noticed.
    // A non-string githubUserId fails the typeof guard before any comparison,
    // so it must be reported as no_props with a null presented id - not
    // misread as a wrong-owner probe carrying a number in a string field.
    expect(refusalReason({ githubUserId: 583231 })).toBe("no_props");
    const entry = JSON.parse(lines[0]!);
    expect(entry.presented_user_id).toBeNull();
    expect(entry.reason).toBe("no_props");
  });

  it("REFUSES a padded or whitespaced id rather than trimming it", () => {
    expect(refusalReason({ githubUserId: " 583231" })).toBe("not_owner");
    expect(refusalReason({ githubUserId: "0583231" })).toBe("not_owner");
  });

  it("compares against the CURRENT config, which is what makes revocation immediate", () => {
    const grant = { githubUserId: "583231" };
    expect(assertOwner(config, grant, "r1")).toBe("583231");

    // The operator changed OWNER_GITHUB_USER_ID and redeployed. Every existing
    // grant still carries the old id, so the very next request fails - without
    // waiting on KV's eventual consistency to propagate a deletion.
    const rotated = { ...config, ownerGithubUserId: "111111" };
    expect(() => assertOwner(rotated, grant, "r1")).toThrow(NotOwnerError);
  });

  it("LOGS the presented id on refusal, which is the one identity exception", () => {
    // A rejected identity is the only signal that someone is probing.
    try {
      assertOwner(config, { githubUserId: "999999" }, "r1");
    } catch {
      /* expected */
    }
    const entry = JSON.parse(lines[0]!);
    expect(entry.event).toBe("auth_failure");
    expect(entry.presented_user_id).toBe("999999");
    expect(entry.reason).toBe("not_owner");
  });

  it("logs a null presented id when there were no props to read", () => {
    try {
      assertOwner(config, {}, "r1");
    } catch {
      /* expected */
    }
    const entry = JSON.parse(lines[0]!);
    expect(entry.presented_user_id).toBeNull();
    expect(entry.reason).toBe("no_props");
  });

  it("logs NOTHING on success, because a successful request is not a security event", () => {
    assertOwner(config, { githubUserId: "583231" }, "r1");
    expect(lines).toEqual([]);
  });

  it("never calls GitHub", () => {
    // Per-request identity resolution would spend a 5,000-per-hour quota on
    // routine tool calls and add a round trip to every one.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    assertOwner(config, { githubUserId: "583231" }, "r1");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
