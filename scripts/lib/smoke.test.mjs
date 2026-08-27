import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("the scripts test project", () => {
  // Spawning a process is the capability these scripts actually need and the
  // one workerd genuinely cannot provide. An earlier draft of this test used
  // node:crypto, which would have PASSED before the config change: this
  // Worker sets nodejs_compat and Cloudflare supports node:crypto, so the
  // "watch it fail" step would have failed to fail.
  it("can spawn a child process", async () => {
    const { stdout } = await execFileAsync("node", ["-e", "process.stdout.write('ok')"]);
    expect(stdout).toBe("ok");
  });

  // Fails if the project's `include` is wrong and this file was picked up by
  // the workers project instead.
  it("has a real Node process with a version", () => {
    expect(process.versions.node).toMatch(/^\d+\./);
  });
});
