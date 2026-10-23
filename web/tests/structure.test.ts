import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Inventory defect 4: every business module carries its own tests.
describe("module layout", () => {
  it("has at least one *.test.ts in every src/modules/* directory", () => {
    const root = path.resolve(import.meta.dirname, "../src/modules");
    const missing = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
      .filter((d) => !readdirSync(path.join(root, d.name)).some((f) => f.endsWith(".test.ts"))).map((d) => d.name);
    expect(missing).toEqual([]);
  });
});
