"""Multi-object tracker + collision heuristic, adapted from the Traffic & Vehicle Monitoring System
(`video_analyzer.py`, `_VehicleTracker`).

What was kept from the reference:
  * Hungarian (optimal) assignment of tracks to detections over a cost that mixes centroid distance
    and box-size similarity - a greedy nearest-neighbour matcher swaps IDs exactly when two vehicles
    converge, which is when collision detection matters most.
  * Collision signature = a vehicle that was moving, then stops almost instantly and stays stopped for
    the next step; overlap with another vehicle box => "vehicle" collision, otherwise "object".

What changed: motion is expressed per SECOND (not per processed frame), because the browser samples
frames at a variable rate, and tracks expose a smoothed speed + a `stopped` flag used for queue
estimation.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import linear_sum_assignment

Box = tuple[int, int, int, int]
MIN_BOX_AREA_PCT = 0.0015
COLLISION_IOU = 0.20


def iou(a: Box, b: Box) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter == 0:
        return 0.0
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


@dataclass
class Track:
    id: int
    box: Box
    cls: str
    center: tuple[float, float]
    t: float
    hist: list = field(default_factory=list)  # (t, cx, cy)
    missed: int = 0
    age: int = 1
    speed: float = 0.0  # diagonals / second, smoothed
    stopped_for: float = 0.0
    conf: float = 0.0


class Tracker:
    def __init__(self, max_dist_frac: float = 0.09, max_missed: int = 5, hist_len: int = 10):
        self.tracks: dict[int, Track] = {}
        self.next_id = 1
        self.max_dist_frac = max_dist_frac
        self.max_missed = max_missed
        self.hist_len = hist_len
        self.last_t = None

    def reset(self) -> None:
        self.tracks.clear()
        self.next_id = 1
        self.last_t = None

    def update(self, dets: list[dict], t: float, w: int, h: int) -> list[Track]:
        """dets: [{'box': (x1,y1,x2,y2), 'cls': str, 'conf': float}]"""
        diag = math.hypot(w, h)
        max_dist = self.max_dist_frac * diag
        ids = list(self.tracks.keys())
        centers = [((d["box"][0] + d["box"][2]) / 2, (d["box"][1] + d["box"][3]) / 2) for d in dets]
        areas = [max(1, (d["box"][2] - d["box"][0]) * (d["box"][3] - d["box"][1])) for d in dets]
        matched_t, matched_d = set(), set()
        if ids and dets:
            INVALID = 1e6
            cost = np.full((len(ids), len(dets)), INVALID)
            for i, tid in enumerate(ids):
                tr = self.tracks[tid]
                ta = max(1, (tr.box[2] - tr.box[0]) * (tr.box[3] - tr.box[1]))
                # constant-velocity prediction keeps IDs stable for fast vehicles
                dt = max(0.0, t - tr.t)
                vx = vy = 0.0
                if len(tr.hist) >= 2:
                    t0, x0, y0 = tr.hist[-2]
                    t1, x1, y1 = tr.hist[-1]
                    if t1 > t0:
                        vx, vy = (x1 - x0) / (t1 - t0), (y1 - y0) / (t1 - t0)
                px, py = tr.center[0] + vx * dt * 0.7, tr.center[1] + vy * dt * 0.7
                for j, c in enumerate(centers):
                    d = math.hypot(c[0] - px, c[1] - py)
                    if d > max_dist or dets[j]["cls"] != tr.cls and not {tr.cls, dets[j]["cls"]} <= {"car", "truck", "bus"}:
                        continue
                    ratio = max(ta, areas[j]) / min(ta, areas[j])
                    if ratio > 3.0:
                        continue
                    cost[i, j] = d
            for i, j in zip(*linear_sum_assignment(cost)):
                if cost[i, j] >= INVALID:
                    continue
                self._apply(self.tracks[ids[i]], dets[j], centers[j], t)
                matched_t.add(ids[i])
                matched_d.add(j)
        for tid in ids:
            if tid not in matched_t:
                self.tracks[tid].missed += 1
        self.tracks = {k: v for k, v in self.tracks.items() if v.missed <= self.max_missed}
        for j, d in enumerate(dets):
            if j not in matched_d:
                tr = Track(self.next_id, tuple(int(v) for v in d["box"]), d["cls"], centers[j], t, conf=d.get("conf", 0.0))
                tr.hist.append((t, centers[j][0], centers[j][1]))
                self.tracks[self.next_id] = tr
                self.next_id += 1
        self._speeds(diag)
        self.last_t = t
        return [tr for tr in self.tracks.values() if tr.missed == 0]

    def _apply(self, tr: Track, d: dict, c: tuple[float, float], t: float) -> None:
        tr.box = tuple(int(v) for v in d["box"])
        tr.center = c
        tr.t = t
        tr.cls = d["cls"]
        tr.conf = d.get("conf", tr.conf)
        tr.missed = 0
        tr.age += 1
        tr.hist.append((t, c[0], c[1]))
        if len(tr.hist) > self.hist_len:
            tr.hist.pop(0)

    def _speeds(self, diag: float) -> None:
        for tr in self.tracks.values():
            if len(tr.hist) < 2 or tr.missed:
                continue
            # average speed over the last ~0.6 s of history
            t1, x1, y1 = tr.hist[-1]
            j = len(tr.hist) - 2
            while j > 0 and t1 - tr.hist[j][0] < 0.6:
                j -= 1
            t0, x0, y0 = tr.hist[j]
            dt = max(1e-3, t1 - t0)
            v = math.hypot(x1 - x0, y1 - y0) / dt / diag
            tr.speed = 0.6 * tr.speed + 0.4 * v if tr.age > 3 else v
            if tr.speed < 0.012:
                tr.stopped_for += max(0.0, t1 - tr.hist[-2][0])
            else:
                tr.stopped_for = 0.0

    def detect_collisions(self, w: int, h: int) -> list[dict]:
        """Abrupt-stop + overlap heuristic (ported from the reference implementation)."""
        diag = math.hypot(w, h)
        area_f = w * h
        out = []
        for tr in self.tracks.values():
            if tr.missed or len(tr.hist) < 6:
                continue
            pts = tr.hist[-6:]
            sp = [math.hypot(pts[k + 1][1] - pts[k][1], pts[k + 1][2] - pts[k][2]) / max(1e-3, pts[k + 1][0] - pts[k][0]) / diag for k in range(5)]
            pre = sp[:3]           # sustained motion before the impact...
            s1, s2 = sp[3], sp[4]  # ...then two consecutive near-zero steps
            before = sum(pre) / 3
            bw, bh = tr.box[2] - tr.box[0], tr.box[3] - tr.box[1]
            if bw * bh < area_f * MIN_BOX_AREA_PCT or min(pre) < 0.07 or max(pre) > 0.9:
                continue  # a single big jump is an ID switch / detector glitch, not a vehicle
            best_iou, partner_speed = 0.0, 0.0
            for o in self.tracks.values():
                if o.id != tr.id and not o.missed:
                    v = iou(tr.box, o.box)
                    if v > best_iou:
                        best_iou, partner_speed = v, o.speed
            if best_iou >= COLLISION_IOU and partner_speed > max(0.03, before * 0.4):
                best_iou = 0.0  # overlap with a vehicle that is still moving = perspective occlusion, not a crash
            if s1 <= before * 0.12 and s2 <= before * 0.12:
                if best_iou >= COLLISION_IOU:
                    out.append({"box": tr.box, "kind": "vehicle", "conf": min(0.65 + best_iou * 0.4, 0.93), "id": tr.id})
                elif before >= 0.16 and s1 <= before * 0.08 and s2 <= before * 0.08:
                    out.append({"box": tr.box, "kind": "object", "conf": 0.58, "id": tr.id})
        return out
