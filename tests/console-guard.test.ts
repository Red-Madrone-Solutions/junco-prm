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

describe("no console outside src/log.ts", () => {
  it("finds no console call in any module except src/log.ts", () => {
    const offenders = Object.entries(modules)
      .filter(([path]) => !path.endsWith("/src/log.ts"))
      .filter(([, content]) => /\bconsole\s*\./.test(content))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});
