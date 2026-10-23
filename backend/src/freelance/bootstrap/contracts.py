"""Public API schema. Domain rules remain in the framework-free use cases."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, JsonValue, StrictInt, StrictStr, model_validator
from freelance.modules.discovery.rules import preferences


class Contract(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, allow_inf_nan=False)


class Settings(Contract):
    max_weekly_hours: float | None
    min_fixed_twd: float
    categories: list[str]

    @model_validator(mode='after')
    def check_rules(self):
        preferences(self.model_dump())
        return self


class PreferencesView(Contract):
    revision: StrictInt
    settings: Settings


class FeedbackCommand(Contract):
    versions: dict[str, StrictStr]
    feedback: Literal['neutral', 'interested', 'skipped']


class Saved(Contract):
    status: Literal['saved'] = 'saved'


class Error(Contract):
    error: str


class Job(Contract):
    source: str
    external_id: str
    title: str
    description: str
    company: str | None = None
    url: str | None = None
    canonical_url: str | None = None
    kind: str | None = None
    currency: str | None = None
    budget_min: float | None = None
    budget_max: float | None = None
    weekly_hours: float | None = None
    taiwan_eligible: bool | None = None
    timezone_compatible: bool | None = None
    deadline: str | None = None
    listing_closed: bool | None = None
    location: str | None = None
    location_evidence: str | list[JsonValue] | dict[str, JsonValue] | None = None
    published_at: str | None = None
    publication_evidence: str | None = None
    complete: bool | None = None
    body_available: bool | None = None
    observed_amount: str | None = None
    compensation_evidence: str | None = None
    language: str | None = None
    remote_scope: str | None = None


class Evaluation(Contract):
    status: Literal['qualified', 'needs_info', 'excluded']
    category: str
    score: float
    reasons: list[str]
    questions: list[str]
    portfolio_ids: list[str]
    method: str
    available_hours: float | None


class Recommendation(Contract):
    score: float
    completeness: int
    freshness: str
    reasons: list[str]
    method: str
    basis_fingerprint: str


class Member(Contract):
    id: str
    source: str
    url: str | None = None
    fingerprint: str
    observation_fingerprints: list[str]
    token: str
    revision: int


class ContentVersion(Contract):
    fingerprint: str
    job: Job
    evaluation: Evaluation
    original: bool


class ContentConflict(Contract):
    source: str
    external_id: str
    versions: list[ContentVersion]
    changed_fields: list[str]


class DisplayBasis(Contract):
    source: str
    fingerprint: str
    label: str


class Tracking(Contract):
    feedback: Literal['neutral', 'interested', 'skipped'] | None
    stage: str | None
    revision: int | None


class Item(Contract):
    id: str
    job: Job
    evaluation: Evaluation
    recommendation: Recommendation
    review_status: str
    members: list[Member]
    member_ids: list[str]
    content_conflicts: list[ContentConflict]
    display_basis: DisplayBasis | None = None
    tracking: Tracking
    candidate: bool
    application_ids: list[str] = []


class ApplicationFields(Contract):
    title: StrictStr
    contact: StrictStr
    url: StrictStr | None
    applied_on: StrictStr
    stage: Literal['applied', 'negotiating', 'won', 'closed']
    follow_up_on: StrictStr | None
    note: StrictStr


class ApplicationCreate(ApplicationFields):
    request_id: StrictStr
    versions: dict[str, StrictStr]
    proposal_id: StrictStr | None = None
    proposal_version: StrictInt | None = None
    submission_id: StrictStr | None = None
    party: 'PartySelection | None' = None


class ApplicationUpdate(ApplicationFields):
    revision: StrictInt


class ApplicationDelete(Contract):
    revision: StrictInt


class PartySnapshot(Contract):
    client_id: str
    client_name: str
    contact_id: str | None
    contact_name: str | None
    contact_address: str | None


class ApplicationProposal(Contract):
    draft_id: str
    draft_version: int
    title: str
    submission_id: str | None
    evidence: dict[str,JsonValue] | None


class ApplicationView(ApplicationFields):
    id: str
    revision: int
    created_at: str
    updated_at: str
    deleted_at: str | None
    opportunity_ids: list[str]
    party: PartySnapshot | None
    proposal: ApplicationProposal | None


class ApplicationList(Contract):
    items: list[ApplicationView]
    total: int
    offset: int
    limit: int


class ApplicationSummary(Contract):
    weekly_count: int
    due_count: int
    overdue_count: int
    week_start: str
    today: str


class RevisionCommand(Contract):
    revision: StrictInt


class PartySelection(Contract):
    client_id: StrictStr | None
    client_revision: StrictInt | None
    contact_id: StrictStr | None
    contact_revision: StrictInt | None


class ApplicationPartyCommand(PartySelection):
    revision: StrictInt


class ClientCreate(Contract):
    request_id: StrictStr
    name: StrictStr
    note: StrictStr


class ClientUpdate(Contract):
    revision: StrictInt
    name: StrictStr
    note: StrictStr


class ClientView(Contract):
    id: str
    name: str
    note: str
    revision: int
    created_at: str
    updated_at: str
    archived_at: str | None


class ClientList(Contract):
    items: list[ClientView]
    total: int
    offset: int
    limit: int


class ContactCreate(ClientCreate):
    client_id: StrictStr
    client_revision: StrictInt
    address: StrictStr


class ContactUpdate(ClientUpdate):
    address: StrictStr


class ContactView(ClientView):
    client_id: str
    address: str


class ContactList(Contract):
    items: list[ContactView]
    total: int
    offset: int
    limit: int


class TemplateCreate(Contract):
    request_id: StrictStr
    name: StrictStr
    body: StrictStr


class TemplateUpdate(Contract):
    revision: StrictInt
    name: StrictStr
    body: StrictStr


class TemplateView(Contract):
    id: str
    name: str
    body: str
    revision: int
    created_at: str
    updated_at: str
    archived_at: str | None


class TemplateList(Contract):
    items: list[TemplateView]
    total: int
    offset: int
    limit: int


class TemplatePreview(Contract):
    body: StrictStr
    values: dict[str, StrictStr]


class RenderedTemplate(Contract):
    body: str
    missing: list[str]


class ProposalCreate(Contract):
    request_id: StrictStr
    title: StrictStr
    body: StrictStr | None
    template_id: StrictStr | None
    template_revision: StrictInt | None
    values: dict[str, StrictStr]
    versions: dict[str, StrictStr]
    party: PartySelection | None


class ProposalAppend(Contract):
    revision: StrictInt
    request_id: StrictStr
    body: StrictStr


class ProposalApplyTemplate(RevisionCommand):
    request_id: StrictStr
    template_id: StrictStr
    template_revision: StrictInt
    values: dict[str,StrictStr]


class ProposalVersion(Contract):
    draft_id: str
    version: int
    body: str
    values: dict[str,str]
    missing: list[str]
    template_snapshot: TemplateView | None
    created_at: str


class ProposalSource(Contract):
    job: dict[str,JsonValue]
    member_ids: list[str]


class ProposalView(Contract):
    id: str
    title: str
    revision: int
    source_tokens: dict[str,str]
    source_snapshot: ProposalSource | None
    party: PartySnapshot | None
    created_at: str
    updated_at: str
    archived_at: str | None
    versions: list[ProposalVersion] | None = None


class ProposalList(Contract):
    items: list[ProposalView]
    total: int
    offset: int
    limit: int


class SubmissionCreate(Contract):
    request_id: StrictStr
    draft_id: StrictStr
    draft_version: StrictInt
    provider: Literal['email','freelancer']
    environment: Literal['live','sandbox']
    account: StrictStr
    fields: dict[str,JsonValue]


class SubmissionApprove(RevisionCommand):
    snapshot_hash: StrictStr


class SubmissionReconcile(RevisionCommand):
    outcome: Literal['user_reported']
    note: StrictStr
    reference: StrictStr


class SubmissionView(Contract):
    id: str
    draft_id: str
    draft_version: int
    snapshot: dict[str,JsonValue]
    snapshot_hash: str
    approval_hash: str | None
    status: Literal['prepared','approved','attempted','accepted','rejected','unknown','cancelled']
    revision: int
    created_at: str
    updated_at: str
    attempted_at: str | None
    finished_at: str | None
    receipt: dict[str,JsonValue] | None
    reconciliation: dict[str,JsonValue] | None


class SubmissionList(Contract):
    items: list[SubmissionView]
    total: int
    offset: int
    limit: int


class SubmissionCapability(Contract):
    status: Literal['not_configured','configured_unverified','sandbox_verified','live_ready']
    account: str | None
    environment: Literal['live','sandbox'] | None
    can_dispatch: bool


class SubmissionCapabilities(Contract):
    email: SubmissionCapability
    freelancer: SubmissionCapability


class DispatchView(Contract):
    intent_id: str
    queued: bool


class Capabilities(Contract):
    discovery: Literal[True] = True


class SourceRun(Contract):
    local_date: str
    status: Literal['ok', 'failed', 'partial', 'waiting', 'unknown']
    reason: Literal['invalid_data', 'incomplete_scan', 'source_error', 'waiting_for_notification'] | None
    seen: int | None
    jobs: int | None
    rejected_count: int | None
    pages: int | None
    quarantined: int | None
    error_count: int | None
    metadata_seen: int | None
    body_reads: int | None
    messages: int | None
    truncated: bool | None
    limited: bool | None
    complete_scan: bool | None


class SourceCheck(Contract):
    status: Literal['not_connected', 'ok', 'failed', 'waiting']
    checked_at: str | None
    latest_daily: SourceRun | None


class DailyRun(Contract):
    local_date: str
    status: Literal['running', 'complete', 'failed']
    started_at: str
    finished_at: str | None
    delivery_status: Literal['pending', 'attempted', 'sent', 'unknown'] | None


class Operations(Contract):
    last_run: DailyRun | None
    sources: dict[str, SourceCheck]


class Dashboard(Contract):
    mode: Literal['demo', 'sqlite']
    items: list[Item]
    sources: dict[str, Literal['not_connected', 'ok', 'failed', 'waiting']]
    platforms: dict[str, str]
    preferences: PreferencesView
    categories: list[str]
    capabilities: Capabilities
    schedule: str
    schedule_enabled: bool
    intake_enabled: bool
    operations: Operations
