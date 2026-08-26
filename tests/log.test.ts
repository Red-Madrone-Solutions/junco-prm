import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logAuthFailure, logRequest, logToolCall, newRequestId } from "../src/log";

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

describe("newRequestId", () => {
  it("is unique per call", () => {
    expect(newRequestId()).not.toBe(newRequestId());
  });
});

describe("logToolCall", () => {
  it("emits parseable JSON carrying the fields an operator needs", () => {
    logToolCall({ requestId: "r1", tool: "log_encounter", durationMs: 12, outcome: "ok" });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      request_id: "r1",
      tool: "log_encounter",
      duration_ms: 12,
      outcome: "ok",
    });
  });

  it("carries the error code on a failure, because that is the debuggable part", () => {
    logToolCall({
      requestId: "r1",
      tool: "promote_roster_entry",
      durationMs: 3,
      outcome: "error",
      code: "conflict",
    });
    expect(JSON.parse(lines[0]!).code).toBe("conflict");
  });

  it("HAS NO FIELD that could carry PRM content", () => {
    // The signature is the enforcement. There is no `message`, no `detail`,
    // no `input`, and no `result` - so there is nothing to interpolate a name
    // into, and this rule is checkable by reading one file.
    logToolCall({ requestId: "r1", tool: "get_person", durationMs: 1, outcome: "ok" });
    const entry = JSON.parse(lines[0]!);
    expect(Object.keys(entry).sort()).toEqual([
      "code",
      "duration_ms",
      "event",
      "outcome",
      "request_id",
      "tool",
    ]);
  });
});

describe("logAuthFailure", () => {
  it("records the presented numeric id, which is the one identity exception", () => {
    // A rejected identity is the only signal that someone is probing the
    // instance, and a numeric GitHub id is public information.
    logAuthFailure({ requestId: "r1", presentedUserId: "999999", reason: "not_owner" });
    const entry = JSON.parse(lines[0]!);
    expect(entry.presented_user_id).toBe("999999");
    expect(entry.reason).toBe("not_owner");
  });

  it("handles a request that presented no identity at all", () => {
    logAuthFailure({ requestId: "r1", presentedUserId: null, reason: "no_token" });
    expect(JSON.parse(lines[0]!).presented_user_id).toBeNull();
  });

  it("takes a reason from a fixed set, not free text", () => {
    // Typed as a union in the signature. This test documents the intent; the
    // compiler is what enforces it.
    logAuthFailure({ requestId: "r1", presentedUserId: null, reason: "no_token" });
    expect(JSON.parse(lines[0]!).reason).toBe("no_token");
  });

  it("HAS NO FIELD beyond the one deliberate identity exception", () => {
    // Same reasoning as logToolCall's key-set test: this is the function
    // where the one identity exception lives, so it is the function most
    // tempting to widen with "one more helpful field."
    logAuthFailure({ requestId: "r1", presentedUserId: "999999", reason: "not_owner" });
    const entry = JSON.parse(lines[0]!);
    expect(Object.keys(entry).sort()).toEqual([
      "event",
      "presented_user_id",
      "reason",
      "request_id",
    ]);
  });
});

describe("logRequest", () => {
  it("records the path but never a query string", async () => {
    // An OAuth authorize URL carries state and a redirect_uri in its query.
    // Neither is PRM content, but neither belongs in a log an operator will
    // paste into a support thread either.
    logRequest({
      requestId: "r1",
      method: "GET",
      path: "/authorize",
      status: 302,
      durationMs: 4,
    });
    const entry = JSON.parse(lines[0]!);
    expect(entry.path).toBe("/authorize");
    expect(JSON.stringify(entry)).not.toContain("?");
  });

  it("strips a query string when the caller passes one in, rather than trusting the caller", () => {
    // A fixture with no "?" in it proves nothing about stripping - it only
    // proves the fixture happened to be clean. This one carries the state
    // and redirect_uri an OAuth authorize URL actually has.
    logRequest({
      requestId: "r1",
      method: "GET",
      path: "/authorize?state=abc123&redirect_uri=https://example.com/cb",
      status: 302,
      durationMs: 4,
    });
    const entry = JSON.parse(lines[0]!);
    expect(entry.path).toBe("/authorize");
    expect(JSON.stringify(entry)).not.toContain("?");
    expect(JSON.stringify(entry)).not.toContain("state=abc123");
    expect(JSON.stringify(entry)).not.toContain("redirect_uri");
  });

  it("HAS NO FIELD beyond what an operator needs to read a request line", () => {
    logRequest({
      requestId: "r1",
      method: "GET",
      path: "/authorize",
      status: 302,
      durationMs: 4,
    });
    const entry = JSON.parse(lines[0]!);
    expect(Object.keys(entry).sort()).toEqual([
      "duration_ms",
      "event",
      "method",
      "path",
      "request_id",
      "status",
    ]);
  });
});
