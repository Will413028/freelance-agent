"""FastAPI adapter; discovery and explicit workbench submission are separate."""
import asyncio
import json
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError, ResponseValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from starlette.exceptions import HTTPException
from freelance.bootstrap.demo import demo_store, PLATFORMS
from freelance.modules.notifications.digest import render
from freelance.modules.discovery.rules import CATEGORIES, group_items, public_item
from freelance.platform.errors import Conflict, InvalidAction
from freelance.bootstrap.contracts import Dashboard, Item, PreferencesView, FeedbackCommand, Saved, Error
from freelance.bootstrap.contracts import ApplicationCreate, ApplicationUpdate, ApplicationDelete, ApplicationView, ApplicationList, ApplicationSummary

HEADERS = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}


class LocalBoundary:
    """ASGI transport limits, independent of route/domain validation."""
    def __init__(self, app, hosts):
        self.app, self.hosts = app, frozenset(hosts)

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)

        async def reject(status, message):
            await JSONResponse({'error': message}, status_code=status, headers=HEADERS)(scope, receive, send)

        headers = {}
        for key, value in scope['headers']:
            headers.setdefault(key.lower(), []).append(value.decode('latin1'))
        if headers.get(b'host') not in [[host] for host in self.hosts]:
            return await reject(403, '只允許本機存取')
        if scope['method'] in ('POST', 'PATCH', 'DELETE'):
            if headers.get(b'origin') not in [['http://127.0.0.1:3327'], ['http://localhost:3327']]:
                return await reject(403, '不允許的來源')
            if len(headers.get(b'content-type', [])) != 1 or headers[b'content-type'][0].split(';')[0].strip() != 'application/json':
                return await reject(415, '需要 JSON')
            body = bytearray()
            try:
                async with asyncio.timeout(5):
                    while True:
                        message = await receive()
                        if message['type'] == 'http.disconnect':
                            return
                        body.extend(message.get('body', b''))
                        if len(body) > 65536:
                            return await reject(413, '請求大小不符限制')
                        if not message.get('more_body', False):
                            break
                if not body:
                    return await reject(413, '請求大小不符限制')
                if not isinstance(json.loads(body), dict):
                    return await reject(400, 'JSON 必須為物件')
            except (ValueError, UnicodeError, TimeoutError):
                return await reject(400, '請求格式不正確')
            consumed = False
            original_receive = receive

            async def buffered_receive():
                nonlocal consumed
                if not consumed:
                    consumed = True
                    return {'type': 'http.request', 'body': bytes(body), 'more_body': False}
                return await original_receive()
            receive = buffered_receive

        started = False
        async def secured_send(message):
            nonlocal started
            if message['type'] == 'http.response.start':
                started = True
                message = dict(message)
                message['headers'] = list(message.get('headers', [])) + [
                    (key.lower().encode(), value.encode()) for key, value in HEADERS.items()]
            await send(message)
        try:
            await self.app(scope, receive, secured_send)
        except Exception:
            # Never let provider/DB exceptions reach an ASGI server's traceback log.
            if not started:
                await reject(503, '案件儲存服務暫時無法使用，請重新載入確認修改結果')


def create_app(store=None, *, mode='demo', intake_enabled=False, schedule_enabled=False,
               hosts=('127.0.0.1:8327', 'localhost:8327'),submission_runtime=None):
    if mode not in ('demo', 'sqlite') or (mode != 'demo' and store is None):
        raise ValueError('Persistent mode requires an explicit store')
    if mode=='demo' and submission_runtime is not None:raise ValueError('Demo cannot enable external submission')
    @asynccontextmanager
    async def lifespan(app):
        nonlocal store
        owns_store = store is None
        if owns_store:
            store = demo_store()
        try:
            yield
        finally:
            if owns_store:
                store.database.close()
                store = None

    app = FastAPI(title='Freelance Discovery', version='1.0.0', docs_url=None,
                  redoc_url=None, openapi_url=None, redirect_slashes=False,
                  lifespan=lifespan,
                  responses={code: {'model': Error, 'description': description} for code, description in (
                      (400, 'Bad Request'), (403, 'Forbidden'), (404, 'Not Found'),
                      (409, 'Conflict'), (413, 'Content Too Large'),
                      (415, 'Unsupported Media Type'), (503, 'Service Unavailable'))})
    app.add_middleware(LocalBoundary, hosts=hosts)

    async def error_response(request, exc):
        if isinstance(exc, Conflict):
            code, message = 409, str(exc)
        elif isinstance(exc, InvalidAction):
            code, message = 400, str(exc)
        elif isinstance(exc, RequestValidationError):
            code, message = 400, '請求格式不正確'
        elif isinstance(exc, KeyError):
            code, message = 404, '找不到案件'
        elif isinstance(exc, HTTPException):
            code, message = exc.status_code, '找不到資源' if exc.status_code == 404 else '不支援的請求'
        else:
            code, message = 503, '案件儲存服務暫時無法使用，請重新載入確認修改結果'
        return JSONResponse({'error': message}, status_code=code, headers=HEADERS)

    for error in (Conflict, InvalidAction, RequestValidationError, ResponseValidationError, KeyError, HTTPException, Exception):
        app.add_exception_handler(error, error_response)

    def sources():
        return dict.fromkeys(PLATFORMS, 'not_connected') if mode == 'demo' else store.sources()

    @app.get('/dashboard', response_model=Dashboard, response_model_exclude_unset=True, operation_id='get_dashboard')
    def dashboard():
        return dict(mode=mode, items=[public_item(item) for item in group_items(store.list())],
                    sources=sources(), platforms=PLATFORMS, preferences=store.preferences(),
                    categories=list(CATEGORIES), capabilities={'discovery': True},
                    schedule='每天 09:00 · Asia/Taipei',
                    schedule_enabled=bool(schedule_enabled) and mode != 'demo',
                    intake_enabled=bool(intake_enabled) and mode != 'demo',
                    operations=store.operations())

    @app.get('/opportunities/{key}', response_model=Item, response_model_exclude_unset=True, operation_id='get_opportunity')
    def opportunity(key: str):
        return public_item(store.opportunity(key))

    @app.get('/digest', response_class=HTMLResponse, operation_id='preview_digest')
    def digest():
        return render(group_items(store.list()), sources(), mode=mode)

    @app.post('/preferences', response_model=PreferencesView, operation_id='set_preferences')
    def settings(command: PreferencesView):
        return store.set_preferences(command.revision, command.settings.model_dump())

    @app.post('/feedback/{key}', response_model=Saved, operation_id='set_feedback')
    def feedback(key: str, command: FeedbackCommand):
        return store.feedback(key, command.versions, command.feedback)

    @app.get('/applications', response_model=ApplicationList, operation_id='list_applications')
    def applications(stage: str | None = None, due: bool = False, offset: int = 0, limit: int = 50,client_id:str|None=None):
        return store.list_applications(stage=stage,due=due,offset=offset,limit=limit,client_id=client_id)

    @app.get('/applications/summary', response_model=ApplicationSummary, operation_id='application_summary')
    def application_summary():
        return store.application_summary()

    @app.post('/applications', response_model=ApplicationView, operation_id='create_application')
    def create_application(command: ApplicationCreate):
        payload=command.model_dump()
        for key in ('proposal_id','proposal_version','submission_id','party'):
            if key not in command.model_fields_set:payload.pop(key)
        return store.create_application(payload)

    @app.patch('/applications/{key}', response_model=ApplicationView, operation_id='update_application')
    def update_application(key: str, command: ApplicationUpdate):
        return store.update_application(key,command.model_dump())

    @app.get('/applications/{key}', response_model=ApplicationView, operation_id='get_application')
    def get_application(key: str):
        return store.get_application(key)

    @app.delete('/applications/{key}', response_model=Saved, operation_id='delete_application')
    def delete_application(key: str, command: ApplicationDelete):
        return store.delete_application(key,command.revision)

    from .workbench_http import register_workbench
    register_workbench(app,lambda:store,runtime=submission_runtime)

    # FastAPI's default 422 is mapped to the established 400 error contract.
    base_openapi = app.openapi
    def openapi():
        schema = base_openapi()
        for path in schema['paths'].values():
            for operation in path.values():
                if isinstance(operation, dict):
                    operation.get('responses', {}).pop('422', None)
        return schema
    app.openapi = openapi
    return app
