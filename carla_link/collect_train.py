"""Generate a labelled traffic dataset inside CARLA and fine-tune YOLOv8 on it.

Method follows the Traffic & Vehicle Monitoring System (scripts/option_3/train*.py): CCTV-style cameras at
a signalised junction, exact 3D->2D bounding boxes from CARLA ground truth, YOLO-format labels, then
`ultralytics` training. Additions: a depth camera rejects boxes of vehicles hidden behind others, weather
is randomised, and pedestrians are labelled too.

  python -m carla_link.collect_train --images 600 --epochs 12        # collect + train
  python -m carla_link.collect_train --collect-only --images 800
  python -m carla_link.collect_train --train-only --epochs 20

Classes: 0 car, 1 truck, 2 bus, 3 motorcycle, 4 person
"""
from __future__ import annotations

import argparse
import json
import math
import random
import shutil
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "carla_link" / "dataset"
MODEL_OUT = ROOT / "backend" / "models" / "carla_yolov8n.pt"
NAMES = ["car", "truck", "bus", "motorcycle", "person"]
W, H, FOV = 960, 540, 85


def vehicle_class(bp_id: str, wheels: int, extent) -> int | None:
    if wheels == 2:
        return 3
    if "bus" in bp_id or "sprinter" in bp_id or "volkswagen.t2" in bp_id or extent.x > 3.2:
        return 2 if extent.x > 3.2 else 0
    if any(k in bp_id for k in ("truck", "carlacola", "cybertruck", "ambulance", "firetruck", "fusorosa")) or extent.z > 1.2:
        return 1
    return 0


def matrix(tr):
    import carla  # noqa: F401
    r, l = tr.rotation, tr.location
    cy, sy, cr, sr, cp, sp = (math.cos(math.radians(r.yaw)), math.sin(math.radians(r.yaw)), math.cos(math.radians(r.roll)), math.sin(math.radians(r.roll)), math.cos(math.radians(r.pitch)), math.sin(math.radians(r.pitch)))
    m = np.identity(4)
    m[:3, 3] = [l.x, l.y, l.z]
    m[0, 0], m[0, 1], m[0, 2] = cp * cy, cy * sp * sr - sy * cr, -cy * sp * cr - sy * sr
    m[1, 0], m[1, 1], m[1, 2] = sy * cp, sy * sp * sr + cy * cr, -sy * sp * cr + cy * sr
    m[2, 0], m[2, 1], m[2, 2] = sp, -cp * sr, cp * cr
    return m


def project(actor, cam, K):
    """8 box corners -> pixel coordinates (+ depth), as in the reference SimulationBBoxProjector."""
    import carla
    e = actor.bounding_box.extent
    pts = np.array([[sx * e.x, sy * e.y, sz * e.z, 1] for sx in (1, -1) for sy in (1, -1) for sz in (-1, 1)]).T
    bb = matrix(carla.Transform(actor.bounding_box.location))
    world = matrix(actor.get_transform()) @ bb @ pts
    sensor = np.linalg.inv(matrix(cam.get_transform())) @ world
    if np.any(sensor[0] <= 0.5):
        return None
    c = np.vstack([sensor[1], -sensor[2], sensor[0]])
    p = (K @ c).T
    return np.stack([p[:, 0] / p[:, 2], p[:, 1] / p[:, 2], p[:, 2]], axis=1)


def collect(args):
    import carla
    import cv2
    client = carla.Client(args.host, args.port)
    client.set_timeout(60)
    world = client.get_world()
    if args.map not in world.get_map().name:
        world = client.load_world(args.map)
    rng = random.Random(args.seed)
    tm = client.get_trafficmanager(8000)
    tm.set_synchronous_mode(True)
    tm.set_random_device_seed(args.seed)
    st = world.get_settings()
    st.synchronous_mode, st.fixed_delta_seconds = True, 0.05
    world.apply_settings(st)
    bp = world.get_blueprint_library()
    spawns = world.get_map().get_spawn_points()
    rng.shuffle(spawns)
    actors, vehicles, walkers = [], [], []
    for sp in spawns[: args.vehicles]:
        b = rng.choice(list(bp.filter("vehicle.*")))
        v = world.try_spawn_actor(b, sp)
        if v:
            v.set_autopilot(True, tm.get_port())
            vehicles.append(v)
    wb = list(bp.filter("walker.pedestrian.*"))
    ctl_bp = bp.find("controller.ai.walker")
    for _ in range(args.walkers):
        loc = world.get_random_location_from_navigation()
        if loc is None:
            continue
        w = world.try_spawn_actor(rng.choice(wb), carla.Transform(loc))
        if w:
            c = world.spawn_actor(ctl_bp, carla.Transform(), attach_to=w)
            world.tick()
            c.start()
            c.go_to_location(world.get_random_location_from_navigation())
            c.set_max_speed(1.2 + rng.random() * 0.6)
            walkers.append(w)
            actors.append(c)
    actors += vehicles + walkers
    # CCTV cameras at junctions with traffic lights
    lights = list(world.get_actors().filter("traffic.traffic_light"))
    centers = []
    for l in lights:
        if all(l.get_location().distance(c) > 40 for c in centers):
            centers.append(l.get_location())
    centers = centers[:6]
    cams = []
    for c in centers:
        for k in range(2):
            yaw = rng.uniform(0, 360)
            tr = carla.Transform(c + carla.Location(x=math.cos(math.radians(yaw)) * 22, y=math.sin(math.radians(yaw)) * 22, z=rng.uniform(9, 16)), carla.Rotation(pitch=rng.uniform(-35, -22), yaw=yaw + 180))
            rb = bp.find("sensor.camera.rgb"); db = bp.find("sensor.camera.depth")
            for b in (rb, db):
                b.set_attribute("image_size_x", str(W)); b.set_attribute("image_size_y", str(H)); b.set_attribute("fov", str(FOV))
            rgb, dep = world.spawn_actor(rb, tr), world.spawn_actor(db, tr)
            store = {}
            rgb.listen(lambda im, s=store: s.__setitem__("rgb", im)); dep.listen(lambda im, s=store: s.__setitem__("dep", im))
            cams.append((rgb, dep, store)); actors += [rgb, dep]
    f = W / (2 * math.tan(math.radians(FOV) / 2))
    K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]])
    for sub in ("images/train", "images/val", "labels/train", "labels/val"):
        (DATA / sub).mkdir(parents=True, exist_ok=True)
    weathers = [carla.WeatherParameters.ClearNoon, carla.WeatherParameters.CloudyNoon, carla.WeatherParameters.WetNoon, carla.WeatherParameters.ClearSunset, carla.WeatherParameters.SoftRainNoon, carla.WeatherParameters.WetCloudySunset]
    n, tick, counts = 0, 0, [0] * 5
    t0 = time.time()
    try:
        while n < args.images:
            world.tick()
            tick += 1
            if tick % 400 == 0:
                world.set_weather(rng.choice(weathers))
            if tick < 120 or tick % 10:
                continue
            rgb, dep, store = rng.choice(cams)
            if "rgb" not in store or "dep" not in store or store["rgb"].frame != store["dep"].frame:
                continue
            im = np.frombuffer(store["rgb"].raw_data, np.uint8).reshape(H, W, 4)[:, :, :3].copy()
            d = np.frombuffer(store["dep"].raw_data, np.uint8).reshape(H, W, 4).astype(np.float32)
            depth_m = (d[:, :, 2] + d[:, :, 1] * 256 + d[:, :, 0] * 65536) / (256 ** 3 - 1) * 1000
            lines = []
            for a in vehicles + walkers:
                if not a.is_alive:
                    continue
                dist = a.get_location().distance(rgb.get_transform().location)
                if dist > 85 or dist < 4:
                    continue
                pr = project(a, rgb, K)
                if pr is None:
                    continue
                x1, y1, x2, y2 = max(0, pr[:, 0].min()), max(0, pr[:, 1].min()), min(W - 1, pr[:, 0].max()), min(H - 1, pr[:, 1].max())
                bw, bh = x2 - x1, y2 - y1
                if bw < 14 or bh < 14 or x2 <= 0 or y2 <= 0 or x1 >= W or y1 >= H:
                    continue
                # visibility: the depth at a few points inside the box must be close to the actor's own distance
                ys, xs = np.linspace(y1 + bh * .3, y2 - bh * .3, 4).astype(int), np.linspace(x1 + bw * .3, x2 - bw * .3, 4).astype(int)
                seen = float(np.mean(np.abs(depth_m[np.ix_(ys, xs)] - dist) < max(3.0, dist * 0.12)))
                if seen < 0.35:
                    continue
                if a.type_id.startswith("walker"):
                    cls = 4
                else:
                    cls = vehicle_class(a.type_id, int(a.attributes.get("number_of_wheels", 4)), a.bounding_box.extent)
                counts[cls] += 1
                lines.append(f"{cls} {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} {bw / W:.6f} {bh / H:.6f}")
            if not lines:
                continue
            split = "val" if n % 7 == 0 else "train"
            cv2.imwrite(str(DATA / "images" / split / f"c{n:05d}.jpg"), im, [cv2.IMWRITE_JPEG_QUALITY, 90])
            (DATA / "labels" / split / f"c{n:05d}.txt").write_text("\n".join(lines))
            n += 1
            if n % 50 == 0:
                print(f"  {n}/{args.images} images, boxes per class {dict(zip(NAMES, counts))}  ({time.time() - t0:.0f}s)", flush=True)
    finally:
        for c in actors:
            try:
                if hasattr(c, "stop"):
                    c.stop()
                c.destroy()
            except Exception:
                pass
        tm.set_synchronous_mode(False)
        st.synchronous_mode = False
        world.apply_settings(st)
    (DATA / "dataset.yaml").write_text(f"path: {DATA.as_posix()}\ntrain: images/train\nval: images/val\nnames:\n" + "".join(f"  {i}: {n_}\n" for i, n_ in enumerate(NAMES)))
    return {"images": n, "boxes": dict(zip(NAMES, counts))}


def train(args):
    from ultralytics import YOLO
    base = ROOT / "backend" / "models" / "yolov8n.pt"
    model = YOLO(str(base))
    res = model.train(data=str(DATA / "dataset.yaml"), epochs=args.epochs, imgsz=args.imgsz, batch=8, device="cpu", workers=2, project=str(DATA / "runs"), name="carla", exist_ok=True, verbose=False, plots=False)
    best = Path(res.save_dir) / "weights" / "best.pt"
    MODEL_OUT.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(best, MODEL_OUT)
    m = YOLO(str(MODEL_OUT)).val(data=str(DATA / "dataset.yaml"), imgsz=args.imgsz, device="cpu", verbose=False, plots=False)
    base_m = None
    return {"map50": float(m.box.map50), "map50_95": float(m.box.map), "per_class_map50": {NAMES[i]: float(v) for i, v in zip(m.box.ap_class_index, m.box.ap50)}, "model": str(MODEL_OUT.relative_to(ROOT)), "epochs": args.epochs, "base_metrics": base_m}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1"); ap.add_argument("--port", type=int, default=2000)
    ap.add_argument("--map", default="Town10HD_Opt"); ap.add_argument("--seed", type=int, default=3)
    ap.add_argument("--images", type=int, default=600); ap.add_argument("--vehicles", type=int, default=90); ap.add_argument("--walkers", type=int, default=40)
    ap.add_argument("--epochs", type=int, default=12); ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--collect-only", action="store_true"); ap.add_argument("--train-only", action="store_true")
    a = ap.parse_args()
    report = {}
    if not a.train_only:
        if DATA.exists():
            shutil.rmtree(DATA)
        report["dataset"] = collect(a)
    if not a.collect_only:
        report["training"] = train(a)
    Path(ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "docs" / "carla_training.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
