"""Validated runtime configuration shared by CLI and consumer composition."""
from dataclasses import dataclass
from freelance.modules.collection.public import enabled_sources

@dataclass(frozen=True)
class DailySettings:
    database: str
    key_file: str
    inbox: str
    recipient: str
    output_dir: str
    live_read: bool = False
    live_send: bool = False
    freelancer_read: bool = False
    free_boards: bool = False
    linkedin_read: bool = False
    cake_read: bool = False
    jobbank104_read: bool = False
    talent_read: bool = False
    sender: str | None = None
    smtp_config: str | None = None
    sources: tuple[str, ...] | None = None

    def __post_init__(self):
        self.selected_sources()
        for name in ('live_read', 'live_send', 'freelancer_read', 'free_boards', 'linkedin_read', 'cake_read', 'jobbank104_read', 'talent_read'):
            if type(getattr(self, name)) is not bool:
                raise ValueError('Opt-in flags must be boolean')
        for name in ('database', 'key_file', 'inbox', 'recipient', 'output_dir'):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip() or any(c in value for c in '\r\n'):
                raise ValueError('Explicit runtime paths and addresses required')
        if not self.live_read:
            raise ValueError('live_read must be explicitly enabled')
        if self.live_send != bool(self.sender or self.smtp_config) or (self.sender and self.smtp_config):
            raise ValueError('Send requires exactly one configured sender')

    def selected_sources(self):
        return enabled_sources(sources=self.sources, freelancer=self.freelancer_read,
            free_boards=self.free_boards, linkedin=self.linkedin_read, cake=self.cake_read,
            jobbank104=self.jobbank104_read, talent=self.talent_read)
