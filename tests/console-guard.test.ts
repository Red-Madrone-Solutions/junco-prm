/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * REPO-WIDE GUARD: src/log.ts is the only module allowed to call console.
 *
 * Vite's glob import inlines every matched file's contents at build time.
 * Tests run inside workerd, which has no filesystem, so node:fs cannot scan
 * src/ at runtime - this is the only way to read the source from a test here.
 */
const modules = import.meta.glob("/src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/**
 * THE ONE EXCEPTION, and it is scoped to an exact line, not a file.
 *
 * src/idempotency.ts logs a reclaimed idempotency claim - see the comment at
 * that call site. It cannot route through src/log.ts: that module is plan 2
 * (it is only ever imported from src/auth/* and src/index.ts today), and
 * src/idempotency.ts is plan 1 code with no Worker dependency, so importing
 * plan 2's logger would invert the dependency the whole plan rests on.
 *
 * The exception is keyed to the exact call text so it stays this narrow: any
 * OTHER console call added to src/idempotency.ts, or a change to this one that
 * starts interpolating free text, still fails the guard. It is not a blanket
 * exemption for the file.
 */
const ALLOWED_CONSOLE_CALLS: Array<{ path: string; line: string }> = [
  {
    path: "/src/idempotency.ts",
    line: 'console.log(JSON.stringify({ event: "idempotency_claim_reclaimed", tool }));',
  },
];

describe("no console outside src/log.ts", () => {
  it("finds no console call in any module except src/log.ts", () => {
    const offenders = Object.entries(modules)
      .filter(([path]) => !path.endsWith("/src/log.ts"))
      .flatMap(([path, content]) => {
        const consoleLines = (content.match(/^.*\bconsole\s*\..*$/gm) ?? []).map((line) =>
          line.trim()
        );
        const allowedForPath = new Set(
          ALLOWED_CONSOLE_CALLS.filter((a) => a.path === path).map((a) => a.line)
        );
        const unexplained = consoleLines.filter((line) => !allowedForPath.has(line));
        return unexplained.length > 0 ? [path] : [];
      });

    expect(offenders).toEqual([]);
  });
});
