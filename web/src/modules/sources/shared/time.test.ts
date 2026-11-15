import { describe, expect, it } from "vitest";
import parsedate from "./parsedate.fixtures.json";
import { rfc2822Instant, utcInstant } from "./time";

describe("utcInstant", () => {
  it.each([
    ["2026-09-18T12:00:00+05:30", "2026-09-18T06:30:00.000Z"],
    ["2026-09-18T12:00:00+05", "2026-09-18T07:00:00.000Z"],
    ["2026-09-18 12:00:00-0800", "2026-09-18T20:00:00.000Z"],
    ["2026-09-18T12:00:00.5Z", "2026-09-18T12:00:00.500Z"],
    ["2026-09-18T12:00:00", "2026-09-18T12:00:00.000Z"],
    ["2026-09-18", "2026-09-18T00:00:00.000Z"],
    ["0099-01-02", "0099-01-02T00:00:00.000Z"],
  ])("%s", (text, want) => expect(utcInstant(text)).toBe(want));

  it.each(["bad", "ZZ", "", "2026-02-30", "2026-09-18T25:00:00"])("refuses %j", (text) => expect(utcInstant(text)).toBeNull());
});

describe("rfc2822Instant", () => {
  it("refuses a negative hour, minute or second, as datetime did", () => {
    expect(["10:-5:00", "10:05:-1", "-1:05:00"].map((t) => rfc2822Instant(`Mon, 01 Jan 2024 ${t} +0000`))).toEqual([null, null, null]);
  });

  it("knows email.utils' zone names, AST and ADT included", () => {
    expect(["AST", "ADT", "EST", "PDT"].map((z) => rfc2822Instant(`Sat, 24 Oct 2026 07:50:03 ${z}`))).toEqual(
      ["2026-10-24T11:50:03.000Z", "2026-10-24T10:50:03.000Z", "2026-10-24T12:50:03.000Z", "2026-10-24T14:50:03.000Z"]);
  });
});

describe("rfc2822Instant over email.utils.parsedate_to_datetime's cases (parsedate.fixtures.json)", () => {
  const cases = parsedate.parsedate as { input: unknown; expect: { ok: string } | { error: string } }[];
  it(`${cases.length} inputs: an aware result is the same instant, a naive result or an error is null`, () => {
    const bad = cases.filter((c) => typeof c.input === "string").flatMap((c) => {
      const ok = "ok" in c.expect ? c.expect.ok : null;
      const instant = ok && /[+-]\d\d:\d\d$/.test(ok) ? new Date(ok).toISOString() : null;
      // Accepted: the contract's instants stop at year 9999 in UTC, and Python's int() also read non-ASCII digits.
      const want = instant && !instant.startsWith("+") && !/(?![0-9])\p{Nd}/u.test(c.input as string) ? instant : null;
      const got = rfc2822Instant(c.input as string);
      return got === want ? [] : [{ input: c.input, want, got, expect: c.expect }];
    });
    expect(bad).toEqual([]);
  });
});
