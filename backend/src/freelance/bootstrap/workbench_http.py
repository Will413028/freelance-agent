"""Workbench API composition; external effects require a separate runtime."""
from . import contracts as c
from freelance.modules.proposals.public import render
from freelance.platform.errors import Conflict


def register_workbench(app,get_store,*,runtime=None):
    @app.get('/clients',response_model=c.ClientList,operation_id='list_clients')
    def clients(offset:int=0,limit:int=50,include_archived:bool=False):
        return get_store().relationships.list_clients(offset=offset,limit=limit,include_archived=include_archived)

    @app.post('/clients',response_model=c.ClientView,operation_id='create_client')
    def create_client(command:c.ClientCreate):return get_store().relationships.create_client(command.model_dump())

    @app.get('/clients/{key}',response_model=c.ClientView,operation_id='get_client')
    def client(key:str):return get_store().relationships.get_client(key)

    @app.patch('/clients/{key}',response_model=c.ClientView,operation_id='update_client')
    def update_client(key:str,command:c.ClientUpdate):return get_store().relationships.update_client(key,command.model_dump())

    @app.post('/clients/{key}/archive',response_model=c.ClientView,operation_id='archive_client')
    def archive_client(key:str,command:c.RevisionCommand):return get_store().relationships.archive_client(key,command.revision)

    @app.get('/clients/{key}/contacts',response_model=c.ContactList,operation_id='list_contacts')
    def contacts(key:str,offset:int=0,limit:int=50,include_archived:bool=False):
        return get_store().relationships.list_contacts(key,offset=offset,limit=limit,include_archived=include_archived)

    @app.post('/contacts',response_model=c.ContactView,operation_id='create_contact')
    def create_contact(command:c.ContactCreate):return get_store().relationships.create_contact(command.model_dump())

    @app.get('/contacts/{key}',response_model=c.ContactView,operation_id='get_contact')
    def contact(key:str):return get_store().relationships.get_contact(key)

    @app.patch('/contacts/{key}',response_model=c.ContactView,operation_id='update_contact')
    def update_contact(key:str,command:c.ContactUpdate):return get_store().relationships.update_contact(key,command.model_dump())

    @app.post('/contacts/{key}/archive',response_model=c.ContactView,operation_id='archive_contact')
    def archive_contact(key:str,command:c.RevisionCommand):return get_store().relationships.archive_contact(key,command.revision)

    @app.post('/applications/{key}/party',response_model=c.ApplicationView,operation_id='set_application_party')
    def party(key:str,command:c.ApplicationPartyCommand):return get_store().set_application_party(key,command.model_dump())

    @app.get('/proposal-templates',response_model=c.TemplateList,operation_id='list_templates')
    def templates(offset:int=0,limit:int=50,include_archived:bool=False):
        return get_store().proposals.list_templates(offset=offset,limit=limit,include_archived=include_archived)

    @app.post('/proposal-templates',response_model=c.TemplateView,operation_id='create_template')
    def create_template(command:c.TemplateCreate):return get_store().proposals.create_template(command.model_dump())

    @app.post('/proposal-templates/preview',response_model=c.RenderedTemplate,operation_id='preview_template')
    def preview_template(command:c.TemplatePreview):return render(command.body,command.values)

    @app.get('/proposal-templates/{key}',response_model=c.TemplateView,operation_id='get_template')
    def template(key:str):return get_store().proposals.get_template(key)

    @app.patch('/proposal-templates/{key}',response_model=c.TemplateView,operation_id='update_template')
    def update_template(key:str,command:c.TemplateUpdate):return get_store().proposals.update_template(key,command.model_dump())

    @app.post('/proposal-templates/{key}/archive',response_model=c.TemplateView,operation_id='archive_template')
    def archive_template(key:str,command:c.RevisionCommand):return get_store().proposals.archive_template(key,command.revision)

    @app.get('/proposals',response_model=c.ProposalList,operation_id='list_proposals')
    def proposals(offset:int=0,limit:int=50,include_archived:bool=False):
        return get_store().proposals.list(offset=offset,limit=limit,include_archived=include_archived)

    @app.post('/proposals',response_model=c.ProposalView,operation_id='create_proposal')
    def create_proposal(command:c.ProposalCreate):return get_store().create_proposal(command.model_dump())

    @app.get('/proposals/{key}',response_model=c.ProposalView,operation_id='get_proposal')
    def proposal(key:str):return get_store().proposals.get(key)

    @app.post('/proposals/{key}/versions',response_model=c.ProposalView,operation_id='append_proposal')
    def append_proposal(key:str,command:c.ProposalAppend):return get_store().proposals.append(key,command.model_dump())

    @app.post('/proposals/{key}/template',response_model=c.ProposalView,operation_id='apply_proposal_template')
    def apply_template(key:str,command:c.ProposalApplyTemplate):return get_store().proposals.apply_template(key,command.model_dump())

    @app.post('/proposals/{key}/archive',response_model=c.ProposalView,operation_id='archive_proposal')
    def archive_proposal(key:str,command:c.RevisionCommand):return get_store().proposals.archive(key,command.revision)

    @app.get('/submission-capabilities',response_model=c.SubmissionCapabilities,operation_id='submission_capabilities')
    def capabilities():
        if runtime is not None:return runtime.capabilities()
        return {k:dict(status='not_configured',account=None,environment=None,can_dispatch=False) for k in ('email','freelancer')}

    @app.get('/submissions',response_model=c.SubmissionList,operation_id='list_submissions')
    def submissions(offset:int=0,limit:int=50):return get_store().submissions.list(offset=offset,limit=limit)

    @app.post('/submissions',response_model=c.SubmissionView,operation_id='prepare_submission')
    def prepare(command:c.SubmissionCreate):return get_store().prepare_submission(command.model_dump())

    @app.get('/submissions/{key}',response_model=c.SubmissionView,operation_id='get_submission')
    def submission(key:str):return get_store().submissions.get(key)

    @app.post('/submissions/{key}/approve',response_model=c.SubmissionView,operation_id='approve_submission')
    def approve(key:str,command:c.SubmissionApprove):return get_store().submissions.approve(key,command.model_dump())

    @app.post('/submissions/{key}/cancel',response_model=c.SubmissionView,operation_id='cancel_submission')
    def cancel(key:str,command:c.RevisionCommand):return get_store().submissions.cancel(key,command.revision)

    @app.post('/submissions/{key}/reconcile',response_model=c.SubmissionView,operation_id='reconcile_submission')
    def reconcile(key:str,command:c.SubmissionReconcile):return get_store().submissions.reconcile(key,command.model_dump())

    @app.post('/submissions/{key}/dispatch',response_model=c.DispatchView,operation_id='dispatch_submission')
    def dispatch(key:str,command:c.RevisionCommand):
        if runtime is None:raise Conflict('此通道尚未配置，未入列或送出')
        return runtime.enqueue(key,command.revision)
