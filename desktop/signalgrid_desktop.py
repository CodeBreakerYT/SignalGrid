"""SignalGrid desktop launcher (Windows .exe entry point).

Starts the vision backend + web UI on a free local port and opens it in a native window:
  1. pywebview (WebView2) if available,
  2. else Edge/Chrome in --app mode (looks like a native window, no address bar),
  3. else the default browser.
Closing the window stops the server.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))))


def free_port(preferred: int = 8765) -> int:
    for p in (preferred, 0):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("no free port")


def find_chromium() -> str | None:
    cands = [os.environ.get("PROGRAMFILES(X86)", "") + r"\Microsoft\Edge\Application\msedge.exe", os.environ.get("PROGRAMFILES", "") + r"\Microsoft\Edge\Application\msedge.exe",
             os.environ.get("PROGRAMFILES", "") + r"\Google\Chrome\Application\chrome.exe", os.environ.get("LOCALAPPDATA", "") + r"\Google\Chrome\Application\chrome.exe"]
    return next((c for c in cands if c and Path(c).exists()), shutil.which("msedge") or shutil.which("chrome"))


def _stdio_to_log() -> None:
    """Windowed builds have no console (sys.stdout is None), which breaks uvicorn's logging."""
    if sys.stdout is None or sys.stderr is None:
        d = Path(os.environ.get("LOCALAPPDATA", ".")) / "SignalGrid"
        d.mkdir(parents=True, exist_ok=True)
        f = open(d / "signalgrid.log", "a", buffering=1, encoding="utf8")
        sys.stdout = sys.stdout or f
        sys.stderr = sys.stderr or f


def main() -> None:
    _stdio_to_log()
    import uvicorn

    from backend.app import create_app

    port = free_port()
    server = uvicorn.Server(uvicorn.Config(create_app(serve_web=True), host="127.0.0.1", port=port, log_level="warning", log_config=None))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    url = f"http://127.0.0.1:{port}/"
    try:
        import webview

        webview.create_window("SignalGrid - Neural Traffic Command", url, width=1440, height=900, min_size=(1000, 650), background_color="#07080f")
        webview.start()
    except Exception:
        browser = find_chromium()
        if browser:
            profile = Path(os.environ.get("LOCALAPPDATA", ".")) / "SignalGrid" / "profile"
            proc = subprocess.Popen([browser, f"--app={url}", f"--user-data-dir={profile}", "--window-size=1440,900", "--no-first-run"])
            proc.wait()
        else:
            webbrowser.open(url)
            print(f"SignalGrid running at {url}  (Ctrl+C to quit)")
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                pass
    server.should_exit = True


if __name__ == "__main__":
    main()
