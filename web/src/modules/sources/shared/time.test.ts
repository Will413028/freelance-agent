import { describe, expect, it } from "vitest";
import { parseIsoTime, utcInstant } from "./time";

describe("parseIsoTime", () => {
  it.each([
    ["2026-09-18T12:00:00+05:30", { kind: "aware", at: "2026-09-18T06:30:00.000Z" }],
    ["2026-09-18 12:00:00-0800", { kind: "aware", at: "2026-09-18T20:00:00.000Z" }],
    ["2026-09-18T12:00:00.5Z", { kind: "aware", at: "2026-09-18T12:00:00.500Z" }],
    ["2026-09-18T12:00", { kind: "naive", utcIfAssumed: "2026-09-18T12:00:00.000Z" }],
    ["2026-09-18", { kind: "date", date: "2026-09-18" }],
    ["0099-01-02T03:04:05Z", { kind: "aware", at: "0099-01-02T03:04:05.000Z" }],
  ])("%s", (text, want) => expect(parseIsoTime(text)).toEqual(want));

  it.each(["bad", "ZZ", "", "2026-02-30", "2026-09-18T24:00:00", "2026-09-18T12:00:00+24:00", "0000-01-01", "9999-12-31T23:00:00-02:00", "20260918"])(
    "refuses %j", (text) => expect(parseIsoTime(text)).toBeNull());
});

describe("utcInstant", () => {
  it("reads a naive time and a date as UTC", () => {
    expect([utcInstant("2026-09-18 12:00:00"), utcInstant("2026-09-18"), utcInstant("nope")]).toEqual(["2026-09-18T12:00:00.000Z", "2026-09-18T00:00:00.000Z", null]);
  });
});
