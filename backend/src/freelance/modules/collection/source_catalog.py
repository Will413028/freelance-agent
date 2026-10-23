"""Explicit source definitions; no credential access or provider calls at import."""
from dataclasses import dataclass

@dataclass(frozen=True)
class Source:
    name: str
    group: str | None
    runner: str | None
    order: int = 100
    keyed: bool = False
    function: str = "sync"

REGISTRY = {
    'freelancer': Source('Freelancer', 'freelancer', 'freelancer', 5, False),
    'tasker': Source('出任務', 'tasker', 'resend_sync', 0, False, 'sync_tasker'),
    'flexjobs': Source('FlexJobs', None, None, 100, False),
    'justremote': Source('JustRemote', 'free_boards', 'justremote', 21, False),
    'remoters': Source('Remoters', None, None, 100, False),
    'toptal': Source('Toptal', None, None, 100, False),
    'jobicy': Source('Jobicy', 'free_boards', 'free_jobs', 6, True),
    'remotive': Source('Remotive', 'free_boards', 'free_jobs', 7, True),
    'himalayas': Source('Himalayas', 'free_boards', 'himalayas', 8, False),
    'hackernews': Source('Hacker News', 'free_boards', 'community_jobs', 9, True),
    'v2ex': Source('V2EX', 'free_boards', 'community_jobs', 10, True),
    'ptt_soho': Source('PTT SOHO', 'free_boards', 'ptt_soho', 11, False),
    'ptt_codejob': Source('PTT CodeJob', 'free_boards', 'ptt_codejob', 12, False),
    'remoteok': Source('Remote OK', 'free_boards', 'public_feeds', 13, True),
    'realworkfromanywhere': Source('Real Work From Anywhere', 'free_boards', 'public_feeds', 14, True),
    'weworkremotely': Source('We Work Remotely', 'free_boards', 'public_feeds', 15, True),
    'workingnomads': Source('Working Nomads', 'free_boards', 'public_feeds', 16, True),
    'taiwanjobs': Source('台灣就業通', 'free_boards', 'taiwanjobs', 17, False),
    'arbeitnow': Source('Arbeitnow', 'free_boards', 'arbeitnow', 18, False),
    'nodesk': Source('NoDesk', 'free_boards', 'nodesk', 19, False),
    'getonboard': Source('Get on Board', 'free_boards', 'getonboard', 20, False),
    'guru': Source('Guru', None, None, 100, False),
    'cryptojobslist': Source('CryptoJobsList', 'free_boards', 'cryptojobslist', 22, False),
    'linkedin': Source('LinkedIn', 'linkedin', 'resend_sync', 1, False, 'sync_linkedin'),
    'cake': Source('Cake', 'cake', 'resend_sync', 2, False, 'sync_cake'),
    'jobbank104': Source('104 人力銀行', 'jobbank104', 'resend_sync', 3, False, 'sync_104'),
    'dynamitejobs': Source('Dynamite Jobs', 'free_boards', 'dynamitejobs', 23, False),
    'jobbank518': Source('518 熊班', 'free_boards', 'jobbank518', 24, False),
    'chickpt': Source('小雞上工', 'free_boards', 'chickpt', 25, False),
    'talent': Source('Talent.com', 'talent', 'resend_sync', 4, False, 'sync_talent'),
    'glassdoor': Source('Glassdoor', None, 'resend_sync', 26, False, 'sync_glassdoor'),
    'indeed': Source('Indeed', None, 'resend_sync', 27, False, 'sync_indeed'),
}
SOURCES = tuple(REGISTRY)
PLATFORMS = {key: value.name for key, value in REGISTRY.items()}

def enabled_sources(*, sources=None, **flags):
    if sources is not None:
        if isinstance(sources, str) or not isinstance(sources, (tuple, list)) or not sources:
            raise ValueError("Explicit sources must be a nonempty list")
        if any(not isinstance(key, str) or key not in REGISTRY or REGISTRY[key].runner is None for key in sources):
            raise ValueError("Unsupported intake source")
        if len(set(sources)) != len(sources) or any(flags.values()):
            raise ValueError("Duplicate sources or conflicting legacy flags")
        chosen = set(sources)
    else:
        chosen = {key for key, spec in REGISTRY.items() if spec.runner is not None
                  and (key == "tasker" or flags.get(spec.group, False))}
    return tuple(sorted(chosen, key=lambda key: REGISTRY[key].order))
