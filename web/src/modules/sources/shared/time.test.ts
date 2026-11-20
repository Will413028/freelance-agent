import { describe, expect, it } from "vitest";
import fixtures from "./time.fixtures.json";
import { parseIsoTime, pubDateInstant, rfc2822Instant, utcInstant } from "./time";

// Plan step 12d: the standard formats the sources send (time.fixtures.json names where each was seen).

const shown = (text: string) => {
  const p = parseIsoTime(text);
  return p === null ? null
    : p.kind === "date" ? p
    : p.kind === "aware" ? { kind: "aware", instant: p.instant.toISOString() }
    : { kind: "naive", utcIfAssumed: p.utcIfAssumed.toISOString() };
};

describe("parseIsoTime over the sources' formats", () => {
  it.each(fixtures.iso.map((c) => [c.input, c.expect] as const))("%s", (input, want) => expect(shown(input)).toEqual(want));
});

describe("parseIsoTime refuses what is not ISO 8601's extended calendar form", () => {
  it.each([
    "", "bad", "2026-02-30", "2026-09-18T25:00:00", "2026-09-18T12:60", "2026-09-18T12:00:60",
    "2026-09-18T12", "20260918", "2026-W38", "2026-09-18x12:00",     "2026-09-18T12:00:00.Z", "2026-09-18T12:00:00+24:00", "2026-09-18T12:00:00+05:30:15", " 2026-09-18",
  ])("%j", (text) => expect(parseIsoTime(text)).toBeNull());

  it("reads a lowercase t and z as RFC 3339 allows", () => {
    expect(shown("2026-09-18t12:00:00z")).toEqual({ kind: "aware", instant: "2026-09-18T12:00:00.000Z" });
  });

  it("reads a comma decimal sign and any number of fraction digits, as ISO 8601 allows", () => {
    expect([shown("2026-09-18T12:00:00,5Z"), shown("2026-09-18T12:00:00.1234567890Z")]).toEqual([
      { kind: "aware", instant: "2026-09-18T12:00:00.500Z" }, { kind: "aware", instant: "2026-09-18T12:00:00.123Z" }]);
  });

  it("utcInstant and pubDateInstant ignore surrounding whitespace", () => {
    expect([utcInstant("\n 2026-09-18T12:00:00Z \n"), pubDateInstant(" 2026-09-18T12:00:00Z\n")]).toEqual(["2026-09-18T12:00:00.000Z", "2026-09-18T12:00:00.000Z"]);
  });

  it("keeps years below 100 as written", () => {
    expect(utcInstant("0099-01-02")).toBe("0099-01-02T00:00:00.000Z");
  });
});

describe("rfc2822Instant over the sources' formats", () => {
  it.each(fixtures.rfc2822.map((c) => [c.input, c.expect] as const))("%s", (input, want) => expect(rfc2822Instant(input)).toBe(want));
});

describe("rfc2822Instant follows RFC 5322's date-time", () => {
  it.each([
    ["24 Oct 2026 07:50:03 +0530", "2026-10-24T02:20:03.000Z"],
    ["Sat, 24 Oct 2026 07:50 GMT", "2026-10-24T07:50:00.000Z"],
    ["Sat, 4 Oct 2026 07:50:03 UT", "2026-10-04T07:50:03.000Z"],
    ["sat, 24 oct 2026 07:50:03 gmt", "2026-10-24T07:50:03.000Z"],
    ["Sat, 24 Oct 2026 07:50:03 EST", "2026-10-24T12:50:03.000Z"],
    ["Sat, 24 Oct 2026 07:50:03 PDT", "2026-10-24T14:50:03.000Z"],
    ["Sat, 24 Oct 26 07:50:03 GMT", "2026-10-24T07:50:03.000Z"],
    ["Sat, 24 Oct 99 07:50:03 GMT", "1999-10-24T07:50:03.000Z"],
    ["Fri, 18 Sep 2026 07:50:03 +0000 (UTC)", "2026-09-18T07:50:03.000Z"],
  ])("%s", (text, want) => expect(rfc2822Instant(text)).toBe(want));

  it.each([
    "", "garbage", "Sat, 24 Oct 2026 07:50:03 -0000", "Sat, 24 Oct 2026 07:50:03 XYZ", "Sat, 24 Oct 2026 07:50:03 AST",
    "Sat, 24 Oct 2026 24:00:00 GMT", "Sat, 24 Oct 2026 07:60:00 GMT", "29 Feb 2025 07:50:03 GMT", "32 Oct 2026 07:50:03 GMT",
    "24 Oc 2026 07:50:03 GMT", "24 Oct 2026 07.50.03 GMT", "Oct 24 2026 07:50:03 GMT", "Sat, 24 Oct 2026 07:50:03 GMT extra",
    "24 Oct 2026 07:50:03 +2400", "24 Oct 2026 07:50:03 +0160",
  ])("refuses %j", (text) => expect(rfc2822Instant(text)).toBeNull());
});

describe("pubDateInstant", () => {
  it("reads ISO with an offset, RFC 2822 with a zone, and nothing without one", () => {
    expect(["2026-09-18T12:00:00Z", "Fri, 18 Sep 2026 07:50:03 GMT", "2026-09-18T12:00:00", "2026-09-18"].map(pubDateInstant))
      .toEqual(["2026-09-18T12:00:00.000Z", "2026-09-18T07:50:03.000Z", null, null]);
  });
});
