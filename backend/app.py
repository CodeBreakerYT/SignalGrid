"""SignalGrid backend: vision API (+ optional static hosting of the web UI).

Run:   python -m backend            (http://127.0.0.1:8765, serves web/ and /api)
API:   GET  /api/health
       POST /api/analyze?session=ID&t=SECONDS&conf=0.3&people=1   body = JPEG bytes
       POST /api/reset?session=ID
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .vision import Analyzer


def resource_root() -> Path:
    """Project root in dev mode, PyInstaller bundle dir when frozen."""
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))


def create_app(serve_web: bool = True, prefer: str | None = None) -> FastAPI:
    app = FastAPI(title="SignalGrid vision backend", version="1.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.middleware("http")
    async def private_network(request: Request, call_next):
        # lets a public https frontend (e.g. Netlify) talk to http://localhost
        resp = await call_next(request)
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        return resp

    analyzer = Analyzer(prefer or os.environ.get("SIGNALGRID_BACKEND", "auto"))
    app.state.analyzer = analyzer

    @app.get("/api/health")
    def health():
        return analyzer.info()

    @app.post("/api/analyze")
    async def analyze(request: Request, session: str = "default", t: float = 0.0, conf: float = 0.3, people: int = 1):
        body = await request.body()
        if not body:
            raise HTTPException(400, "empty body: send a JPEG frame")
        frame = cv2.imdecode(np.frombuffer(body, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            raise HTTPException(400, "could not decode image")
        if not 0.05 <= conf <= 0.95:
            raise HTTPException(400, "conf must be within 0.05..0.95")
        return analyzer.analyze(session[:64], frame, t, conf, bool(people))

    # ---- CARLA bridge: carla_link/bridge.py pushes its camera frame + controller state here; the UI polls them
    carla_box: dict = {"frame": None, "state": None, "t": 0.0}

    @app.post("/api/carla/frame")
    async def carla_frame(request: Request):
        carla_box["frame"], carla_box["t"] = await request.body(), __import__("time").time()
        return Response(status_code=204)

    @app.post("/api/carla/state")
    async def carla_state(request: Request):
        carla_box["state"] = await request.json()
        return Response(status_code=204)

    @app.get("/api/carla/frame.jpg")
    def carla_get_frame():
        if not carla_box["frame"]:
            raise HTTPException(404, "no CARLA frame yet")
        return Response(carla_box["frame"], media_type="image/jpeg", headers={"Cache-Control": "no-store"})

    @app.get("/api/carla/state")
    def carla_get_state():
        live = bool(carla_box["frame"]) and __import__("time").time() - carla_box["t"] < 5
        return {"live": live, "state": carla_box["state"] if live else None}

    @app.post("/api/reset")
    def reset(session: str = "default"):
        analyzer.reset(session[:64])
        return Response(status_code=204)

    if serve_web:
        web = resource_root() / "web"
        if web.exists():
            app.mount("/", StaticFiles(directory=str(web), html=True), name="web")
    return app


app = create_app()
