import { describe, expect, it } from "vitest";
import { SOURCES, sourceLabel, sourceSettings } from "./public";

// Plan step 4, global done-definition: every source has a request interval and a per-run cap.
describe("source catalog", () => {
  it("names and orders each source once", () => {
    expect(new Set(SOURCES.map((s) => s.name)).size).toBe(SOURCES.length);
    expect(new Set(SOURCES.map((s) => s.order)).size).toBe(SOURCES.length);
  });

  it("gives every source an interval of at least a second, a per-run cap and the plain tier until step 8", () => {
    const bad = SOURCES.filter((s) => !(s.minIntervalMs >= 1_000 && Number.isInteger(s.maxRequestsPerRun) && s.maxRequestsPerRun >= 1 && s.maxTier === "plain"));
    expect(bad.map((s) => s.name)).toEqual([]);
  });

  it("finds a source by name and refuses an unknown one", () => {
    expect(sourceSettings("jobicy").name).toBe("jobicy");
    expect(() => sourceSettings("nope")).toThrow(/unknown source/);
  });

  it("marks complete reads only for sources whose one read pages through the whole board (plan D9)", () => {
    expect(SOURCES.filter((s) => s.completeRead).map((s) => s.name)).toEqual(["arbeitnow"]);
  });

  it("gives every source a page label, and falls back to the name", () => {
    // The old catalog's names (ce1254d web/src/modules/collection/source-catalog.ts).
    expect(Object.fromEntries(SOURCES.map((s) => [s.name, s.label]))).toEqual({
      jobbank104: "104 人力銀行",
      remotive: "Remotive", jobicy: "Jobicy", freelancer: "Freelancer", himalayas: "Himalayas", hackernews: "Hacker News", v2ex: "V2EX",
      remoteok: "Remote OK", realworkfromanywhere: "Real Work From Anywhere", weworkremotely: "We Work Remotely", workingnomads: "Working Nomads",
      taiwanjobs: "台灣就業通", arbeitnow: "Arbeitnow", getonboard: "Get on Board", cryptojobslist: "CryptoJobsList",
      nodesk: "NoDesk", justremote: "JustRemote", dynamitejobs: "Dynamite Jobs", jobbank518: "518 熊班", chickpt: "小雞上工",
    });
    expect(sourceLabel("hackernews")).toBe("Hacker News");
    expect(sourceLabel("constructor")).toBe("constructor");
  });
});
