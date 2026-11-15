// What a page shows for each source name, for every source the old catalog listed (ce1254d
// web/src/modules/collection/source-catalog.ts), so a connector added later needs no entry here.
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  freelancer: "Freelancer", tasker: "出任務", flexjobs: "FlexJobs", justremote: "JustRemote", remoters: "Remoters",
  toptal: "Toptal", jobicy: "Jobicy", remotive: "Remotive", himalayas: "Himalayas", hackernews: "Hacker News", v2ex: "V2EX",
  ptt_soho: "PTT SOHO", ptt_codejob: "PTT CodeJob", remoteok: "Remote OK", realworkfromanywhere: "Real Work From Anywhere",
  weworkremotely: "We Work Remotely", workingnomads: "Working Nomads", taiwanjobs: "台灣就業通", arbeitnow: "Arbeitnow",
  nodesk: "NoDesk", getonboard: "Get on Board", guru: "Guru", cryptojobslist: "CryptoJobsList", linkedin: "LinkedIn",
  cake: "Cake", jobbank104: "104 人力銀行", dynamitejobs: "Dynamite Jobs", jobbank518: "518 熊班", chickpt: "小雞上工",
  talent: "Talent.com", glassdoor: "Glassdoor", indeed: "Indeed",
};

/** The label a page shows; the source name itself when it has none. */
export const sourceLabel = (source: string): string => (Object.hasOwn(SOURCE_LABELS, source) ? SOURCE_LABELS[source] : source);
