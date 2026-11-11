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


def wait_for_parent_exit(stopped):
    if sys.platform != "win32":
        sys.stdin.buffer.read(1)
        return

    # A blocked stdin read can deadlock NumPy and SciPy DLL initialization
    # on Windows (numpy/numpy#24290). Poll the parent's pipe without reading.
    import ctypes
    from ctypes import wintypes
    import msvcrt

    peek_pipe = ctypes.WinDLL("kernel32", use_last_error=True).PeekNamedPipe
    peek_pipe.argtypes = (
        wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
        wintypes.LPDWORD, wintypes.LPDWORD, wintypes.LPDWORD,
    )
    peek_pipe.restype = wintypes.BOOL
    pipe = msvcrt.get_osfhandle(sys.stdin.fileno())
    available = wintypes.DWORD()
    while not stopped.is_set():
        if not peek_pipe(pipe, None, 0, None, ctypes.byref(available), None):
            error = ctypes.get_last_error()
            if error not in (109, 232):  # ERROR_BROKEN_PIPE, ERROR_NO_DATA
                raise ctypes.WinError(error)
            return
        if available.value or stopped.wait(0.2):
            return


def run(listener, port, token):
    stopping = threading.Event()
    stopped = threading.Event()
    server = None

    def stop_when_window_exits():
        try:
            wait_for_parent_exit(stopped)
        finally:
            stopping.set()
            if server is not None:
                server.should_exit = True
            if not stopped.wait(5):
                os._exit(0)

    threading.Thread(target=stop_when_window_exits, daemon=True).start()
    try:
        from backend.main import app

        @app.get("/_desktop-ready", include_in_schema=False)
        async def ready(studio_token: str = Header(default="")):
            valid = secrets.compare_digest(studio_token.encode(), token.encode())
            return Response(status_code=204 if valid else 404)

        from backend.release_updates import ReleaseChecker, desktop_update_cache

        app.state.desktop = True
        updates = ReleaseChecker(desktop_update_cache())

        @app.get("/api/updates", include_in_schema=False)
        def update_status():
            return updates.status()

        @app.post("/api/updates/check", include_in_schema=False)
        def check_updates():
            updates.check(manual=True)
            return updates.status()

        if port == 43110:  # stable desktop origin; isolated acceptance runs use ephemeral ports
            updates.check()

        app.mount("/", StaticFiles(directory=Path(__file__).with_name("site"), html=True))
        app.add_middleware(LocalOrigin, host=f"127.0.0.1:{port}")
        server = uvicorn.Server(uvicorn.Config(app, log_level="info", access_log=False, timeout_graceful_shutdown=2))
        if not stopping.is_set():
            server.run(sockets=[listener])
    finally:
        stopped.set()


if __name__ == "__main__":
    port = int(sys.argv[1])
    token = os.environ.pop("SRTS_DESKTOP_LAUNCH_TOKEN")
    port_file = os.environ.pop("SRTS_DESKTOP_PORT_FILE", None)
    if port == 0 and not port_file:
        raise ValueError("A desktop port file is required when requesting an ephemeral port")
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        reuse_option = socket.SO_EXCLUSIVEADDRUSE if sys.platform == "win32" else socket.SO_REUSEADDR
        listener.setsockopt(socket.SOL_SOCKET, reuse_option, 1)
        listener.bind(("127.0.0.1", port))
        port = listener.getsockname()[1]
        if port_file:
            destination = Path(port_file)
            staged = destination.with_suffix(".tmp")
            staged.write_text(str(port), encoding="ascii")
            staged.replace(destination)
        run(listener, port, token)
