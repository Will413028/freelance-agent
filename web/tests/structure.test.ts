import { readdirSync, readFileSync } from "node:fs";
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

// Plan step 11: pages render on the server; a client component ("use client") ships to the browser,
// so it must not import server code (services, db, modules, platform) or read the environment.
describe("client components", () => {
  it("import nothing of the server", () => {
    const root = path.resolve(import.meta.dirname, "../src");
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(root, f));
    const client = files.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    expect(client.length).toBeGreaterThan(0);
    const offending = client.filter((f) => /from\s+["']@\/(services|db|modules|platform|ops|workflows)\b|process\.env/.test(readFileSync(f, "utf8")));
    expect(offending).toEqual([]);
  });
});
