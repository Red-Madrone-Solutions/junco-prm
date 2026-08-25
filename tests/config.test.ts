import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";

/**
 * A complete, valid environment. Each case below removes exactly one thing.
 *
 * THE BINDINGS ARE PART OF "COMPLETE". An earlier version of this helper listed
 * only the five variables, so `loadConfig` refused it for missing `DB` and
 * `OAUTH_KV` and the supposedly-valid case failed - which would have sent
 * whoever hit it looking at the validator rather than at the fixture.
 */
function validEnv() {
  return {
    GITHUB_CLIENT_ID: "Iv1.abc123",
    GITHUB_CLIENT_SECRET: "shhh",
    COOKIE_ENCRYPTION_KEY: "0".repeat(64),
    OWNER_GITHUB_USER_ID: "583231",
    OWNER_TIMEZONE: "America/Los_Angeles",
    DB: {} as D1Database,
    OAUTH_KV: {} as KVNamespace,
  } as never;
}

describe("loadConfig", () => {
  it("returns a Config when everything is present", () => {
    const config = loadConfig(validEnv());
    expect(config.ownerGithubUserId).toBe("583231");
    expect(config.ownerTimezone).toBe("America/Los_Angeles");
  });

  for (const missing of [
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "COOKIE_ENCRYPTION_KEY",
    "OWNER_GITHUB_USER_ID",
    "OWNER_TIMEZONE",
  ] as const) {
    it(`REFUSES when ${missing} is absent`, () => {
      const env = validEnv() as Record<string, string>;
      delete env[missing];
      try {
        loadConfig(env as never);
        throw new Error("should have refused");
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).missing).toContain(missing);
      }
    });

    it(`REFUSES when ${missing} is an empty string`, () => {
      // A secret that was `wrangler secret put` with an accidental newline or
      // nothing at all arrives as "". Present-but-empty must fail like absent.
      const env = validEnv() as Record<string, string>;
      env[missing] = "   ";
      try {
        loadConfig(env as never);
        throw new Error("should have refused");
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).missing).toContain(missing);
      }
    });
  }

  it("names EVERY missing item at once, not just the first", () => {
    // An operator who forgot two secrets should learn that in one deploy.
    const env = validEnv() as Record<string, string>;
    delete env.GITHUB_CLIENT_SECRET;
    delete env.OWNER_TIMEZONE;
    try {
      loadConfig(env as never);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as ConfigError).missing.sort()).toEqual([
        "GITHUB_CLIENT_SECRET",
        "OWNER_TIMEZONE",
      ]);
    }
  });

  it("REFUSES a non-numeric OWNER_GITHUB_USER_ID", () => {
    // The likeliest operator error is pasting a username. Refusing it here
    // makes it impossible to "fix" later by comparing usernames instead,
    // which would reintroduce the takeover the numeric id exists to prevent.
    const env = validEnv() as Record<string, string>;
    env.OWNER_GITHUB_USER_ID = "octocat";
    try {
      loadConfig(env as never);
      throw new Error("should have refused");
    } catch (e) {
      expect((e as ConfigError).missing).toContain("OWNER_GITHUB_USER_ID");
      expect((e as ConfigError).message).toMatch(/numeric/i);
    }
  });

  it("REFUSES an OWNER_TIMEZONE that is not a real IANA zone", () => {
    // An invalid zone throws a RangeError inside Intl. Unvalidated, that
    // surfaces as a crash in list_due rather than as a refused deploy.
    const env = validEnv() as Record<string, string>;
    env.OWNER_TIMEZONE = "America/Los_Angles";
    try {
      loadConfig(env as never);
      throw new Error("should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).missing).toContain("OWNER_TIMEZONE");
      expect((e as ConfigError).message).toMatch(/IANA/i);
    }
  });

  it("accepts UTC, which is a real zone and a plausible choice", () => {
    const env = validEnv() as Record<string, string>;
    env.OWNER_TIMEZONE = "UTC";
    expect(loadConfig(env as never).ownerTimezone).toBe("UTC");
  });

  it("REFUSES a COOKIE_ENCRYPTION_KEY that is too short to be 32 bytes", () => {
    const env = validEnv() as Record<string, string>;
    env.COOKIE_ENCRYPTION_KEY = "abcd";
    try {
      loadConfig(env as never);
      throw new Error("should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).missing).toContain("COOKIE_ENCRYPTION_KEY");
      expect((e as ConfigError).message).toMatch(/32 bytes/i);
    }
  });

  it("never puts a secret in the error message", () => {
    // The error is rendered into a 503 body. A validator that echoes what it
    // rejected is a validator that leaks the thing it was checking.
    const env = validEnv() as Record<string, string>;
    env.COOKIE_ENCRYPTION_KEY = "not-long-enough-but-still-a-secret";
    try {
      loadConfig(env as never);
      throw new Error("should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).not.toContain("not-long-enough");
    }
  });
});
