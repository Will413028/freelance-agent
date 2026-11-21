import { describe, expect, it } from "vitest";
import { SOURCES, sourceLabel, sourceSettings } from "./public";

// Plan step 4, global done-definition: every source has a request interval and a per-run cap.
describe("source catalog", () => {
  it("names and orders each source once", () => {
    expect(new Set(SOURCES.map((s) => s.name)).size).toBe(SOURCES.length);
    expect(new Set(SOURCES.map((s) => s.order)).size).toBe(SOURCES.length);
  });

  it("gives every source an interval of at least a second and a per-run cap", () => {
    const bad = SOURCES.filter((s) => !(s.minIntervalMs >= 1_000 && Number.isInteger(s.maxRequestsPerRun) && s.maxRequestsPerRun >= 1));
    expect(bad.map((s) => s.name)).toEqual([]);
  });

  it("disables only the sources with a lasting block, each with its reason", () => {
    expect(SOURCES.filter((s) => s.disabled).map((s) => s.name)).toEqual(["remoteco"]);
  });

  it("reads every source plain except the ones a plain request cannot read (spikes.md §2, plan step 8)", () => {
    expect(Object.fromEntries(SOURCES.filter((s) => s.maxTier !== "plain").map((s) => [s.name, s.maxTier]))).toEqual({ remoteco: "browser_like", idealist: "browser", braintrust: "browser" });
  });

  it("finds a source by name and refuses an unknown one", () => {
    expect(sourceSettings("jobicy").name).toBe("jobicy");
    expect(() => sourceSettings("nope")).toThrow(/unknown source/);
  });

  it("marks complete reads only for sources whose one read pages through the whole board (plan D9)", () => {
    expect(SOURCES.filter((s) => s.completeRead).map((s) => s.name)).toEqual(["arbeitnow", "devpost", "mlcontests", "zindi"]);
  });

  it("gives every source one opportunity type: jobs, and the contest sources (opportunity types plan D1)", () => {
    expect(SOURCES.filter((s) => s.opportunityType !== "job").map((s) => [s.name, s.opportunityType])).toEqual([["devpost", "contest"], ["mlcontests", "contest"], ["zindi", "contest"]]);
  });

  it("gives every source a page label, and falls back to the name", () => {
    // The old catalog's names (ce1254d web/src/modules/collection/source-catalog.ts).
    expect(Object.fromEntries(SOURCES.map((s) => [s.name, s.label]))).toEqual({
      tasker: "出任務",
      linkedin: "LinkedIn",
      cake: "Cake",
      jobbank104: "104 人力銀行",
      talent: "Talent.com",
      glassdoor: "Glassdoor",
      remotive: "Remotive", jobicy: "Jobicy", freelancer: "Freelancer", himalayas: "Himalayas", hackernews: "Hacker News", v2ex: "V2EX",
      ptt_soho: "PTT SOHO", ptt_codejob: "PTT CodeJob",
      remoteok: "Remote OK", realworkfromanywhere: "Real Work From Anywhere", weworkremotely: "We Work Remotely", workingnomads: "Working Nomads",
      taiwanjobs: "台灣就業通", arbeitnow: "Arbeitnow", getonboard: "Get on Board", cryptojobslist: "CryptoJobsList",
      nodesk: "NoDesk", justremote: "JustRemote", dynamitejobs: "Dynamite Jobs", jobbank518: "518 熊班", chickpt: "小雞上工",
      arc: "Arc", web3career: "Web3.career", wellfound: "Wellfound", remotecom: "Remote.com Jobs", ycjobs: "YC Jobs",
      remoteco: "Remote.co", idealist: "Idealist", braintrust: "Braintrust", devpost: "Devpost", mlcontests: "MLContests", zindi: "Zindi",
    });
    expect(sourceLabel("hackernews")).toBe("Hacker News");
    expect(sourceLabel("constructor")).toBe("constructor");
  });
});
