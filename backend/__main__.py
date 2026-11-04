import argparse

import uvicorn


def main() -> None:
    ap = argparse.ArgumentParser(description="SignalGrid vision backend + static web UI")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-web", action="store_true", help="API only (frontend hosted elsewhere)")
    ap.add_argument("--backend", choices=["auto", "yolo", "opencv"], default="auto")
    a = ap.parse_args()
    from .app import create_app

    uvicorn.run(create_app(serve_web=not a.no_web, prefer=a.backend), host=a.host, port=a.port, log_level="info")


if __name__ == "__main__":
    main()
