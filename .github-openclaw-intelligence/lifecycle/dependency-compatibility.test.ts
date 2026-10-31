import { expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { resolve } from "path";

test("minimatch override preserves the glob APIs used by OpenClaw", () => {
  const output = execFileSync("node", [
    "--input-type=module",
    "--eval",
    `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      const require = createRequire(process.argv[1]);
      const { minimatch, Minimatch, escape } = require("minimatch");

      assert.equal(minimatch(".config/model.json", "**/*.json", { dot: true }), true);
      assert.equal(minimatch("openai/GPT-5.5", "openai/gpt-*", { nocase: true }), true);
      assert.equal(minimatch("anthropic/claude", "openai/*"), false);
      assert.deepEqual(minimatch.match(["a.ts", "b.js", "c.md"], "*.{ts,js}"), ["a.ts", "b.js"]);

      const matcher = new Minimatch("docs/**/*.md", {
        nocomment: true, nonegate: true, windowsPathsNoEscape: true,
      });
      assert.equal(matcher.match("docs/nested/guide.md"), true);
      assert.equal(matcher.match("src/guide.md"), false);
      assert.equal(minimatch("config[1].env", escape("config[1].env")), true);
      assert.equal(minimatch("config1.env", escape("config[1].env")), false);

      const [parts] = new Minimatch("/etc/openclaw/*.env", {
        nobrace: true, noext: true, noglobstar: true,
        platform: "linux", optimizationLevel: 0,
      }).set;
      assert.deepEqual(parts.slice(0, 3), ["", "etc", "openclaw"]);
      assert.equal(parts[3].test("agent.env"), true);
      assert.equal(parts[3].test("agent.txt"), false);
      console.log("compatible");
    `,
    resolve(import.meta.dir, "../node_modules/openclaw/package.json"),
  ], { encoding: "utf8", timeout: 30_000 });

  expect(output.trim()).toBe("compatible");
});
