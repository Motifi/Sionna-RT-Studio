"""Serve the desktop bundle and the existing Studio API on one local origin."""

import os
from pathlib import Path
import secrets
import socket
import sys
import threading

from fastapi import Header
import uvicorn
from starlette.datastructures import Headers
from starlette.responses import Response
from starlette.staticfiles import StaticFiles


class LocalOrigin:
    def __init__(self, app, host):
        self.app = app
        self.host = host
        self.origin = f"http://{host}"

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = Headers(scope=scope)
            origin = headers.get("origin")
            if headers.get("host") != self.host or origin not in (None, self.origin):
                return await Response(status_code=403)(scope, receive, send)
        return await self.app(scope, receive, send)


def run(listener, port, token):
    stopping = threading.Event()
    stopped = threading.Event()
    server = None

    def stop_when_window_exits():
        sys.stdin.buffer.read(1)
        stopping.set()
        if server is not None:
            server.should_exit = True
        if not stopped.wait(5):
            os._exit(0)

    threading.Thread(target=stop_when_window_exits, daemon=True).start()
    try:
        from backend.main import app

        @app.get("/_desktop-ready", include_in_schema=False)
        def ready(studio_token: str = Header(default="")):
            valid = secrets.compare_digest(studio_token.encode(), token.encode())
            return Response(status_code=204 if valid else 404)

        app.mount("/", StaticFiles(directory=Path(__file__).with_name("site"), html=True))
        app.add_middleware(LocalOrigin, host=f"127.0.0.1:{port}")
        server = uvicorn.Server(uvicorn.Config(app, log_level="warning", timeout_graceful_shutdown=2))
        if not stopping.is_set():
            server.run(sockets=[listener])
    finally:
        stopped.set()


if __name__ == "__main__":
    port = int(sys.argv[1])
    token = os.environ.pop("SRTS_DESKTOP_LAUNCH_TOKEN")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", port))
        run(listener, port, token)
