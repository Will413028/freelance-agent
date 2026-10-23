"""Loopback Uvicorn entry point and compatibility lifecycle for local tools."""
import argparse
import socket
from threading import Event
import uvicorn
from freelance.bootstrap.http import create_app


class LocalServer:
    """One bound loopback socket, shared by CLI and real HTTP tests."""
    def __init__(self, port, store, *, container=False, **options):
        # Bind once; failed app configuration closes the socket below.
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.stopped = Event()
        self.running = False
        try:
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.socket.bind(('0.0.0.0' if container else '127.0.0.1', port))
            self.socket.listen(128)
            self.server_port = self.socket.getsockname()[1]
            hosts = (f'127.0.0.1:{self.server_port}', f'localhost:{self.server_port}')
            if container:
                hosts += (f'api:{self.server_port}',)
            self.app = create_app(store, hosts=hosts, **options)
            self.server = uvicorn.Server(uvicorn.Config(self.app, access_log=False, log_level='critical', lifespan='on'))
        except BaseException:
            self.socket.close()
            raise

    def serve_forever(self):
        self.running = True
        try:
            self.server.run(sockets=[self.socket])
        finally:
            self.stopped.set()

    def shutdown(self):
        self.server.should_exit = True
        if self.running:
            self.stopped.wait(timeout=10)

    def server_close(self):
        self.socket.close()


def create_server(port=8327, store=None, *, mode='demo', intake_enabled=False, schedule_enabled=False, container=False,submission_runtime=None):
    return LocalServer(port, store, container=container, mode=mode, intake_enabled=intake_enabled, schedule_enabled=schedule_enabled,submission_runtime=submission_runtime)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Loopback discovery API; never sends or imports mail")
    parser.add_argument("--port", type=int, default=8327)
    parser.add_argument('--container', action='store_true', help='bind container network; publish only through loopback Web')
    parser.add_argument("--mode", choices=("demo", "sqlite"), default="demo")
    parser.add_argument("--database", help="existing SQLite database path")
    parser.add_argument('--submissions-config',help='explicit owner-only submission runtime; requires SQLite and queue')
    parser.add_argument('--queue',help='persistent Huey queue shared with the sole worker')
    parser.add_argument("--intake-enabled", action="store_true", help="report an independently verified installed intake schedule")
    parser.add_argument("--schedule-enabled", action="store_true", help="report verified installed Email schedule")
    args = parser.parse_args(argv)
    if (args.intake_enabled or args.schedule_enabled) and args.mode == "demo":
        parser.error("--intake-enabled requires a persistent review mode")
    if args.database and args.mode != "sqlite":
        parser.error("--database requires --mode sqlite")
    if (args.submissions_config or args.queue) and (args.mode!='sqlite' or not args.submissions_config or not args.queue):
        parser.error('--submissions-config requires --mode sqlite and --queue')
    store = None
    if args.mode == "sqlite":
        if not args.database:
            parser.error("SQLite mode requires --database and an already migrated file")
        try:
            from freelance.bootstrap.store import SQLiteStore
            store = SQLiteStore(args.database)
            store.sources()
        except Exception:
            parser.exit(1, "SQLite database unavailable; check path and migration.\n")
    runtime=None
    if args.submissions_config:
        from .submission_runtime import SubmissionRuntime
        runtime=SubmissionRuntime(store,args.submissions_config);runtime.bind_queue(args.queue)
    httpd = create_server(args.port, store, mode=args.mode, intake_enabled=args.intake_enabled, schedule_enabled=args.schedule_enabled, container=args.container,submission_runtime=runtime)
    print(f"Discovery API: http://127.0.0.1:{httpd.server_port} ({args.mode}, no external delivery)", flush=True)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
