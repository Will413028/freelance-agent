import { afterAll, describe, expect, it } from "vitest";
import { db, pool } from "../../tests/helpers/db";
import { writeTransaction } from "./client";

afterAll(async () => { await pool.end(); });

describe("writeTransaction", () => {
  it("serializes writers and gives up after the 5 s lock timeout", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const holder = writeTransaction(db, async () => { entered(); await held; });
    await inside;
    const started = Date.now();
    let code: unknown;
    try {
      await writeTransaction(db, async () => "second");
    } catch (e) {
      code = (e as { cause?: { code?: string } }).cause?.code; // Drizzle wraps the pg error
    } finally {
      release();
      await holder;
    }
    const waited = Date.now() - started;
    expect(code).toBe("55P03"); // lock_not_available
    expect(waited).toBeGreaterThanOrEqual(4_500);
    expect(waited).toBeLessThan(10_000);
    expect(await writeTransaction(db, async () => "after")).toBe("after");
  });
});

describe("strictSslUrl", () => {
  it("pins verify-full for weaker or aliased modes and leaves others alone", async () => {
    const { strictSslUrl } = await import("./client");
    expect(strictSslUrl("postgres://u:p@h.example/db?sslmode=require&channel_binding=require")).toBe("postgres://u:p@h.example/db?sslmode=verify-full&channel_binding=require");
    expect(strictSslUrl("postgres://u@localhost:5432/db")).toBe("postgres://u@localhost:5432/db");
    expect(strictSslUrl("postgres://u@h/db?sslmode=disable")).toBe("postgres://u@h/db?sslmode=disable");
  });
});
