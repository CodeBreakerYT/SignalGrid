"""Run the vision pipeline over a video file and print per-second statistics.
Usage: python tools/test_vision.py <video> [--backend yolo|opencv] [--fps 6] [--seconds 20]
"""
import argparse
import sys
import time
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.vision import Analyzer  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("video")
ap.add_argument("--backend", default="auto")
ap.add_argument("--fps", type=float, default=6)
ap.add_argument("--seconds", type=float, default=20)
ap.add_argument("--save", default="")
a = ap.parse_args()

an = Analyzer(a.backend)
print("backend:", an.info())
cap = cv2.VideoCapture(a.video)
src_fps = cap.get(cv2.CAP_PROP_FPS) or 25
step = max(1, round(src_fps / a.fps))
print(f"video {int(cap.get(3))}x{int(cap.get(4))} @ {src_fps:.1f} fps, sampling every {step} frames")
n, t_start, shown = 0, time.time(), 0
ms = []
best = {}
while True:
    ok, frame = cap.read()
    if not ok or n / src_fps > a.seconds:
        break
    if n % step == 0:
        ok2, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        dec = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        r = an.analyze("test", dec, n / src_fps)
        ms.append(r["ms"])
        if shown % int(a.fps) == 0:
            stopped = sum(d["stopped"] for d in r["detections"] if d["cls"] != "person")
            print(f"t={n / src_fps:5.1f}s ms={r['ms']:6.1f} counts={r['counts']} stopped={stopped} acc={bool(r['accident'])}{' warming' if r['warming'] else ''}")
        shown += 1
        if a.save and shown == int(a.fps * 5):
            for d in r["detections"]:
                x1, y1, x2, y2 = d["box"]
                cv2.rectangle(dec, (x1, y1), (x2, y2), (255, 200, 0), 2)
                cv2.putText(dec, f"{d['cls']}#{d['id']}", (x1, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 200, 0), 1)
            cv2.imwrite(a.save, dec)
    n += 1
print(f"frames analysed: {len(ms)}, mean {sum(ms) / max(1, len(ms)):.1f} ms/frame, wall {time.time() - t_start:.1f}s")
