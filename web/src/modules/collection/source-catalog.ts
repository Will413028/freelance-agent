// Port of collection/source_catalog.py: explicit source definitions. Runners arrive with each
// connector (plan steps 6–9); until then the catalog only validates source ids and orders them.

export type SourceSpec = { name: string; group: string | null; runner: string | null; order: number; keyed: boolean; fn: string };

const s = (name: string, group: string | null, runner: string | null, order = 100, keyed = false, fn = "sync"): SourceSpec =>
  ({ name, group, runner, order, keyed, fn });

export const REGISTRY: Record<string, SourceSpec> = {
  freelancer: s("Freelancer", "freelancer", "freelancer", 5, false),
  tasker: s("出任務", "tasker", "resend_sync", 0, false, "sync_tasker"),
  flexjobs: s("FlexJobs", null, null, 100, false),
  justremote: s("JustRemote", "free_boards", "justremote", 21, false),
  remoters: s("Remoters", null, null, 100, false),
  toptal: s("Toptal", null, null, 100, false),
  jobicy: s("Jobicy", "free_boards", "free_jobs", 6, true),
  remotive: s("Remotive", "free_boards", "free_jobs", 7, true),
  himalayas: s("Himalayas", "free_boards", "himalayas", 8, false),
  hackernews: s("Hacker News", "free_boards", "community_jobs", 9, true),
  v2ex: s("V2EX", "free_boards", "community_jobs", 10, true),
  ptt_soho: s("PTT SOHO", "free_boards", "ptt_soho", 11, false),
  ptt_codejob: s("PTT CodeJob", "free_boards", "ptt_codejob", 12, false),
  remoteok: s("Remote OK", "free_boards", "public_feeds", 13, true),
  realworkfromanywhere: s("Real Work From Anywhere", "free_boards", "public_feeds", 14, true),
  weworkremotely: s("We Work Remotely", "free_boards", "public_feeds", 15, true),
  workingnomads: s("Working Nomads", "free_boards", "public_feeds", 16, true),
  taiwanjobs: s("台灣就業通", "free_boards", "taiwanjobs", 17, false),
  arbeitnow: s("Arbeitnow", "free_boards", "arbeitnow", 18, false),
  nodesk: s("NoDesk", "free_boards", "nodesk", 19, false),
  getonboard: s("Get on Board", "free_boards", "getonboard", 20, false),
  guru: s("Guru", null, null, 100, false),
  cryptojobslist: s("CryptoJobsList", "free_boards", "cryptojobslist", 22, false),
  linkedin: s("LinkedIn", "linkedin", "resend_sync", 1, false, "sync_linkedin"),
  cake: s("Cake", "cake", "resend_sync", 2, false, "sync_cake"),
  jobbank104: s("104 人力銀行", "jobbank104", "resend_sync", 3, false, "sync_104"),
  dynamitejobs: s("Dynamite Jobs", "free_boards", "dynamitejobs", 23, false),
  jobbank518: s("518 熊班", "free_boards", "jobbank518", 24, false),
  chickpt: s("小雞上工", "free_boards", "chickpt", 25, false),
  talent: s("Talent.com", "talent", "resend_sync", 4, false, "sync_talent"),
  glassdoor: s("Glassdoor", null, "resend_sync", 26, false, "sync_glassdoor"),
  indeed: s("Indeed", null, "resend_sync", 27, false, "sync_indeed"),
};

export const SOURCES: readonly string[] = Object.keys(REGISTRY);
export const isSource = (source: unknown): source is string => typeof source === "string" && Object.hasOwn(REGISTRY, source);
