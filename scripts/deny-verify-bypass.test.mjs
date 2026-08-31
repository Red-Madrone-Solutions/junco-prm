import { describe, expect, it } from "vitest";
import { isVerifyBypass } from "./deny-verify-bypass.mjs";

describe("isVerifyBypass", () => {
  it("allows an ordinary commit", () => {
    expect(isVerifyBypass('git commit -m "a message"')).toBe(false);
  });

  it("denies --no-verify before other arguments", () => {
    expect(isVerifyBypass('git commit --no-verify -m "x"')).toBe(true);
  });

  it("denies --no-verify after other arguments, which prefix rules miss", () => {
    expect(isVerifyBypass('git commit -m "x" --no-verify')).toBe(true);
  });

  it("denies the short -n form of commit", () => {
    expect(isVerifyBypass('git commit -n -m "x"')).toBe(true);
  });

  it("denies -n bundled with another short flag", () => {
    expect(isVerifyBypass('git commit -nm "x"')).toBe(true);
  });

  it("denies a push that skips the hook", () => {
    expect(isVerifyBypass("git push --no-verify origin main")).toBe(true);
  });

  it("allows git push -n, which is a dry run and not a hook bypass", () => {
    expect(isVerifyBypass("git push -n origin main")).toBe(false);
  });

  it("denies redirecting hooksPath away from the repository", () => {
    expect(isVerifyBypass("git -c core.hooksPath=/dev/null commit -m x")).toBe(true);
  });

  it("finds a bypass in the second half of a compound command", () => {
    expect(isVerifyBypass("npm test && git commit --no-verify -m x")).toBe(true);
  });

  it("finds a bypass after a semicolon", () => {
    expect(isVerifyBypass("echo hi; git push --no-verify")).toBe(true);
  });

  it("leaves unrelated git commands alone", () => {
    expect(isVerifyBypass("git log --oneline -n 5")).toBe(false);
  });

  it("leaves non-git commands alone", () => {
    expect(isVerifyBypass("npm run build -- --no-verify")).toBe(false);
  });
});
