"""Vision pipeline: YOLOv8 when available, an OpenCV-only fallback otherwise.

Backends
  yolo    ultralytics YOLOv8 (COCO) for cars / trucks / buses / motorcycles / pedestrians. Same model
          family and class mapping as the reference Traffic & Vehicle Monitoring System.
  opencv  Fallback that needs only opencv + numpy: MOG2 background subtraction finds moving vehicles
          (static camera required), HOG finds pedestrians. Much weaker than YOLO and cannot see
          stopped vehicles once they merge into the background; documented as a limitation.

Both feed the same tracker (tracker.py) which adds persistent IDs, speed, a "stopped" flag for queue
estimation and the collision heuristic. An optional accident scene classifier (the reference project's
`accident_detector.pt`) can be enabled with SIGNALGRID_ACCIDENT_MODEL=<path>.
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import cv2
import numpy as np

from .tracker import Tracker

ROOT = Path(__file__).resolve().parent
COCO = {2: "car", 3: "motorcycle", 5: "bus", 7: "truck", 0: "person"}
ACCIDENT_PERSIST_S = 3.0
CLF_CONFIRM_CONF, CLF_CONFIRM_STREAK = 0.75, 2


def find_yolo_weights() -> str | None:
    env = os.environ.get("SIGNALGRID_YOLO")
    cands = [Path(env)] if env else []
    cands += [ROOT / "models" / "yolov8n.pt", ROOT / "models" / "yolov8s.pt"]
    for c in cands:
        if c.exists():
            return str(c)
    return None


class YoloDetector:
    name = "yolo"

    def __init__(self, weights: str, device: str | None = None):
        from ultralytics import YOLO

        self.model = YOLO(weights)
        self.weights = Path(weights).name
        self.device = device
        self.model.predict(np.zeros((64, 64, 3), np.uint8), verbose=False)  # warm-up

    def detect(self, frame: np.ndarray, conf: float, people: bool, state: dict) -> list[dict]:
        classes = list(COCO.keys()) if people else [k for k in COCO if k != 0]
        res = self.model.predict(frame, conf=conf, classes=classes, verbose=False, imgsz=640, device=self.device)
        out = []
        for r in res:
            for b in r.boxes:
                x1, y1, x2, y2 = (int(v) for v in b.xyxy[0].tolist())
                out.append({"box": (x1, y1, x2, y2), "cls": COCO[int(b.cls[0])], "conf": float(b.conf[0])})
        return out


class OpenCVDetector:
    """MOG2 motion blobs (vehicles) + HOG (pedestrians). Static-camera fallback."""

    name = "opencv"
    weights = "MOG2 + HOG"
    device = "cpu"

    def __init__(self):
        self.hog = cv2.HOGDescriptor()
        self.hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

    def new_state(self) -> dict:
        return {"bg": cv2.createBackgroundSubtractorMOG2(history=240, varThreshold=36, detectShadows=True), "n": 0}

    def detect(self, frame: np.ndarray, conf: float, people: bool, state: dict) -> list[dict]:
        h, w = frame.shape[:2]
        scale = 640 / max(w, h) if max(w, h) > 640 else 1.0
        small = cv2.resize(frame, (int(w * scale), int(h * scale))) if scale != 1.0 else frame
        sh, sw = small.shape[:2]
        fg = state["bg"].apply(small)
        state["n"] += 1
        if state["n"] < 12:
            return []  # background model still warming up
        mask = cv2.threshold(fg, 200, 255, cv2.THRESH_BINARY)[1]
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)), iterations=2)
        if mask.mean() / 255 > 0.45:  # camera moved or lighting jump: reset the model
            state["bg"] = cv2.createBackgroundSubtractorMOG2(history=240, varThreshold=36, detectShadows=True)
            state["n"] = 0
            return []
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        out = []
        area_f = sw * sh
        for c in cnts:
            x, y, bw, bh = cv2.boundingRect(c)
            a = bw * bh
            if a < area_f * 0.0012 or a > area_f * 0.35:
                continue
            fill = cv2.contourArea(c) / max(1, a)
            if fill < 0.35:
                continue
            ar = bw / max(1, bh)
            cls = "car"
            if a > area_f * 0.02 and (ar > 2.2 or ar < 0.45):
                cls = "bus" if a > area_f * 0.035 else "truck"
            out.append({"box": (int(x / scale), int(y / scale), int((x + bw) / scale), int((y + bh) / scale)), "cls": cls, "conf": float(min(0.9, 0.4 + fill * 0.5))})
        if people:
            rects, weights = self.hog.detectMultiScale(small, winStride=(8, 8), padding=(8, 8), scale=1.06)
            for (x, y, bw, bh), wgt in zip(rects, np.ravel(weights)):
                if wgt < 0.6:
                    continue
                out.append({"box": (int(x / scale), int(y / scale), int((x + bw) / scale), int((y + bh) / scale)), "cls": "person", "conf": float(min(0.95, wgt / 2))})
        return out


class Session:
    def __init__(self, detector):
        self.tracker = Tracker()
        self.state = detector.new_state() if hasattr(detector, "new_state") else {}
        self.last_used = time.time()
        self.frames = 0
        self.persist = None  # (box, kind, conf, until_t)
        self.clf_streak = 0
        self.count_ids: set[int] = set()
        self.crossed: dict[str, int] = {}


class Analyzer:
    def __init__(self, prefer: str = "auto"):
        self.lock = threading.Lock()
        self.sessions: dict[str, Session] = {}
        self.error = None
        self.detector = None
        self.accident_clf = None
        if prefer in ("auto", "yolo"):
            try:
                w = find_yolo_weights()
                if w:
                    self.detector = YoloDetector(w)
                else:
                    self.error = "YOLO weights not found (backend/models/yolov8n.pt)"
            except Exception as e:  # ultralytics/torch missing or broken
                self.error = f"YOLO unavailable: {type(e).__name__}: {e}"
        if self.detector is None:
            self.detector = OpenCVDetector()
        acc = os.environ.get("SIGNALGRID_ACCIDENT_MODEL")
        if acc and Path(acc).exists() and self.detector.name == "yolo":
            try:
                from ultralytics import YOLO

                self.accident_clf = YOLO(acc)
            except Exception as e:
                self.error = (self.error or "") + f" accident model failed: {e}"

    def info(self) -> dict:
        import cv2 as _cv

        d = self.detector
        return {
            "ok": True, "backend": d.name, "weights": d.weights, "device": str(getattr(d, "device", None) or "auto"),
            "opencv": _cv.__version__, "accident_classifier": self.accident_clf is not None, "note": self.error,
            "classes": sorted(set(COCO.values())) if d.name == "yolo" else ["car/truck/bus (motion blobs)", "person (HOG)"],
        }

    def _session(self, sid: str) -> Session:
        now = time.time()
        for k in [k for k, s in self.sessions.items() if now - s.last_used > 180]:
            del self.sessions[k]
        s = self.sessions.get(sid)
        if s is None:
            s = self.sessions[sid] = Session(self.detector)
        s.last_used = now
        return s

    def reset(self, sid: str) -> None:
        with self.lock:
            self.sessions.pop(sid, None)

    def analyze(self, sid: str, frame: np.ndarray, t: float, conf: float = 0.3, people: bool = True) -> dict:
        t0 = time.perf_counter()
        with self.lock:
            s = self._session(sid)
            h, w = frame.shape[:2]
            if s.tracker.last_t is not None and t < s.tracker.last_t - 0.5:  # video looped/seeked back
                s.tracker.reset()
                s.persist = None
            dets = self.detector.detect(frame, conf, people, s.state)
            veh = [d for d in dets if d["cls"] != "person"]
            tracks = s.tracker.update(dets, t, w, h)
            s.frames += 1
            # only vehicle-vehicle impacts count as accidents: the 'isolated abrupt stop' signature of the
            # reference implementation fires too easily on tracker ID jumps in dense traffic
            collisions = [c for c in s.tracker.detect_collisions(w, h) if c["kind"] == "vehicle"] if veh else []
            if collisions:
                best = max(collisions, key=lambda c: c["conf"])
                s.persist = (best["box"], best["kind"], best["conf"], t + ACCIDENT_PERSIST_S)
            elif s.persist and t > s.persist[3]:
                s.persist = None
            acc = None
            if s.persist:
                acc = {"active": True, "box": list(s.persist[0]), "kind": s.persist[1], "conf": round(s.persist[2], 2), "source": "motion"}
            elif self.accident_clf is not None and s.frames % 6 == 0:
                try:
                    r = self.accident_clf(frame, verbose=False)[0]
                    says = int(r.probs.top1) == 0 and float(r.probs.top1conf) >= CLF_CONFIRM_CONF
                    s.clf_streak = s.clf_streak + 1 if says else 0
                    if s.clf_streak >= CLF_CONFIRM_STREAK:
                        box = max((tr.box for tr in tracks), key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), default=(w // 2 - 40, h // 4 - 30, w // 2 + 40, h // 4 + 30))
                        s.persist = (box, "vehicle", min(0.55 + 0.08 * s.clf_streak, 0.9), t + ACCIDENT_PERSIST_S)
                        acc = {"active": True, "box": list(box), "kind": "vehicle", "conf": round(s.persist[2], 2), "source": "classifier"}
                except Exception:
                    pass
            counts = {"car": 0, "truck": 0, "bus": 0, "motorcycle": 0, "person": 0}
            out = []
            for tr in tracks:
                counts[tr.cls] = counts.get(tr.cls, 0) + 1
                out.append({
                    "id": tr.id, "cls": tr.cls, "conf": round(tr.conf, 2), "box": list(tr.box),
                    "speed": round(tr.speed, 4), "stopped": bool(tr.stopped_for > 1.0 or (tr.speed < 0.012 and tr.age > 4)),
                    "age": tr.age,
                })
            return {
                "backend": self.detector.name, "w": w, "h": h, "t": t, "frame": s.frames,
                "warming": self.detector.name == "opencv" and s.state.get("n", 99) < 12,
                "detections": out, "counts": counts, "accident": acc,
                "ms": round((time.perf_counter() - t0) * 1000, 1),
            }
