"""Drive a real CARLA junction with the SignalGrid neural agent and compare it with a fixed timer.

  python -m carla_link.bridge --mode both --seconds 180 --seed 7

* Connects to a running CARLA 0.9.x server (Town10HD by default), picks a 4-way signalised junction.
* Counts vehicles near each light's stop line (queue, density, waiting time, ambulance) and feeds the SAME
  evolved SignalNet used in the browser simulator (see signalnet.py, verified identical to the JS version).
* Sets the real traffic lights through the same safety layer: minimum green, amber, all-red, maximum green.
  CARLA lights have no separate left arrow, so the agent's two phases per axis share one green.
* Optionally streams a camera frame + live state to the SignalGrid backend, so the web UI shows CARLA live.
* Reports average waiting time, throughput and max queue for each controller (same seed and traffic spawn).
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np

try:
    import carla
except ImportError:  # pragma: no cover
    sys.exit("The 'carla' Python package is missing: pip install <CARLA>/PythonAPI/carla/dist/carla-*.whl (Python 3.12)")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from carla_link.signalnet import SignalNet  # noqa: E402

DT = 0.05
SAFE = {"minGreen": [8, 5, 8, 5], "maxGreen": [55, 22, 55, 22], "amber": 3.0, "allRed": 2.0}
FIXED_AXIS_GREEN = 32.0  # 24 s through + 8 s left in the simulator's fixed plan
ZONE_R = 70.0


class Backend:
    """Fire-and-forget push of frames/state to the SignalGrid backend (optional)."""

    def __init__(self, url: str | None):
        self.url, self.lock, self.pending = url, threading.Lock(), {}
        if url:
            threading.Thread(target=self._loop, daemon=True).start()

    def push(self, kind: str, body: bytes, ctype: str):
        if self.url:
            with self.lock:
                self.pending[kind] = (kind, body, ctype)

    def _loop(self):
        while True:
            time.sleep(0.05)
            with self.lock:
                items, self.pending = list(self.pending.values()), {}
            for item in items:
                try:
                    req = urllib.request.Request(f"{self.url}/api/carla/{item[0]}", data=item[1], headers={"Content-Type": item[2]}, method="POST")
                    urllib.request.urlopen(req, timeout=1).read()
                except Exception as e:
                    print('  [backend push failed]', type(e).__name__, e, flush=True)


class Junction:
    """Groups of real traffic lights, split into two axes by the lights' yaw."""

    def __init__(self, world, group):
        self.lights = group
        self.center = carla.Location(*(sum(getattr(l.get_location(), a) for l in group) / len(group) for a in "xyz"))
        self.axis = {0: [], 1: []}  # 0 = east-west phases (0,1), 1 = north-south phases (2,3)
        for l in group:
            yaw = l.get_transform().rotation.yaw % 180
            self.axis[0 if (yaw < 45 or yaw > 135) else 1].append(l)
        self.stops = {0: [], 1: []}
        for a, ls in self.axis.items():
            for l in ls:
                self.stops[a] += [w.transform for w in l.get_stop_waypoints()]


def pick_junction(world, near: tuple[float, float] | None):
    seen, groups = set(), []
    for l in world.get_actors().filter("traffic.traffic_light"):
        if l.id in seen:
            continue
        g = l.get_group_traffic_lights()
        seen.update(x.id for x in g)
        if len(g) >= 4:
            groups.append(g)
    if not groups:
        raise SystemExit("No 4-way signalised junction found in this map")
    if near:
        groups.sort(key=lambda g: min(math.hypot(l.get_location().x - near[0], l.get_location().y - near[1]) for l in g))
    return Junction(world, groups[0])


def observe(jn: Junction, vehicles, stop_t, cur_phase: int, elapsed: float) -> tuple[np.ndarray, dict]:
    """38-dim sensor vector identical in layout to the browser simulator (web/js/core/sim.js observe())."""
    obs = np.zeros(38, np.float32)
    stats = {0: {"q": 0, "n": 0, "w": 0.0, "em": 0.0}, 1: {"q": 0, "n": 0, "w": 0.0, "em": 0.0}}
    total = 0
    for v in vehicles:
        loc, vel = v.get_location(), v.get_velocity()
        speed = math.hypot(vel.x, vel.y)
        if loc.distance(jn.center) < ZONE_R + 20:
            total += 1
        for a in (0, 1):
            for st in jn.stops[a]:
                fwd = st.get_forward_vector()
                dx, dy = loc.x - st.location.x, loc.y - st.location.y
                along = dx * fwd.x + dy * fwd.y  # < 0 = before the stop line
                lat = abs(dx * -fwd.y + dy * fwd.x)
                if -80 < along < 3 and lat < 3.8 and (vel.x * fwd.x + vel.y * fwd.y > -0.5):
                    s = stats[a]
                    s["n"] += 1
                    if speed < 1.2:
                        s["q"] += 1
                        s["w"] = max(s["w"], stop_t.get(v.id, 0.0))
                    if "ambulance" in v.type_id or "firetruck" in v.type_id or "police" in v.type_id:
                        s["em"] = max(s["em"], 1 + along / 140.0)
                    break
    for p in range(4):
        s, b = stats[0 if p < 2 else 1], p * 8
        share = 0.15 if p % 2 else 0.85  # one camera/lane set per axis: assumed through/left split
        obs[b] = min(1, s["q"] * share / 14)
        obs[b + 1] = min(1, s["n"] * share / 18)
        obs[b + 2] = min(1, s["w"] / 60)
        obs[b + 5] = s["em"]
    obs[32 + cur_phase] = 1
    obs[36] = min(1, elapsed / 60)
    obs[37] = min(1, total / 60)
    return obs, stats


class Controller:
    """Safety state machine around any phase-proposing policy (agent or fixed timer)."""

    def __init__(self, jn: Junction, policy: str, net: SignalNet | None):
        self.jn, self.policy, self.net = jn, policy, net
        self.phase, self.state, self.timer, self.elapsed, self.pending = 0, "green", 0.0, 0.0, -1
        self.decide_t = 0.0
        self.switches = 0
        for l in jn.lights:
            l.freeze(True)
        self.apply()

    def axis_of(self, p):
        return 0 if p < 2 else 1

    def apply(self):
        a = self.axis_of(self.phase)
        for ax, ls in self.jn.axis.items():
            for l in ls:
                if ax != a:
                    l.set_state(carla.TrafficLightState.Red)
                elif self.state == "green":
                    l.set_state(carla.TrafficLightState.Green)
                elif self.state == "amber":
                    l.set_state(carla.TrafficLightState.Yellow)
                else:
                    l.set_state(carla.TrafficLightState.Red)

    def step(self, obs, stats, dt):
        if self.state == "green":
            self.elapsed += dt
            self.decide_t += dt
            if self.pending < 0 and self.decide_t >= 1.0:
                self.decide_t = 0.0
                target = self.phase
                if self.elapsed >= SAFE["minGreen"][self.phase]:
                    if self.policy == "fixed":
                        if self.elapsed >= FIXED_AXIS_GREEN:
                            target = (self.phase + 2) % 4
                    else:
                        target = self.net.decide(obs, self.phase, self.elapsed)
                    other = 1 - self.axis_of(self.phase)
                    if self.elapsed >= SAFE["maxGreen"][self.phase] and stats[other]["n"] > 0:  # starvation / max green guard
                        target = 2 if self.phase < 2 else 0
                    if target != self.phase:
                        self.pending = target
            if self.pending >= 0:
                if self.axis_of(self.pending) == self.axis_of(self.phase):  # left phase: same physical green
                    self.phase, self.pending, self.elapsed = self.pending, -1, 0.0
                    self.switches += 1
                else:
                    self.state, self.timer = "amber", SAFE["amber"]
                    self.apply()
        elif self.state == "amber":
            self.timer -= dt
            if self.timer <= 0:
                self.state, self.timer = "allred", SAFE["allRed"]
                self.apply()
        else:
            self.timer -= dt
            if self.timer <= 0:
                self.phase, self.pending, self.state, self.elapsed = self.pending, -1, "green", 0.0
                self.switches += 1
                self.apply()


def run(world, client, args, policy: str, net: SignalNet | None, backend: Backend) -> dict:
    tm = client.get_trafficmanager(8000)
    tm.set_synchronous_mode(True)
    tm.set_random_device_seed(args.seed)
    settings = world.get_settings()
    settings.synchronous_mode, settings.fixed_delta_seconds = True, DT
    world.apply_settings(settings)
    jn = pick_junction(world, args.near)
    bp = world.get_blueprint_library()
    rng = random.Random(args.seed)
    spawns = sorted(world.get_map().get_spawn_points(), key=lambda s: s.location.distance(jn.center))
    near = [s for s in spawns if 30 < s.location.distance(jn.center) < 260]
    rng.shuffle(near)
    actors, vehicles = [], []
    cars = [b for b in bp.filter("vehicle.*") if int(b.get_attribute("number_of_wheels")) == 4 and "ambulance" not in b.id and "firetruck" not in b.id and "police" not in b.id]
    for sp in near[: args.vehicles]:
        b = rng.choice(cars)
        b.set_attribute("role_name", "autopilot")
        v = world.try_spawn_actor(b, sp)
        if v:
            v.set_autopilot(True, tm.get_port())
            tm.ignore_lights_percentage(v, 0)
            tm.vehicle_percentage_speed_difference(v, rng.uniform(-10, 20))
            vehicles.append(v)
            actors.append(v)
    amb = None
    if args.ambulance and near:
        ab = bp.filter("vehicle.ford.ambulance")
        if ab:
            amb = world.try_spawn_actor(ab[0], near[-1])
            if amb:
                amb.set_autopilot(True, tm.get_port()); tm.ignore_lights_percentage(amb, 0)
                vehicles.append(amb); actors.append(amb)
    cam = None
    frame_holder = {}
    if args.camera:
        cb = bp.find("sensor.camera.rgb")
        cb.set_attribute("image_size_x", "960"); cb.set_attribute("image_size_y", "540"); cb.set_attribute("fov", "80")
        st0 = jn.stops[0][min(args.cam_lane, len(jn.stops[0]) - 1)]  # look down an approach road, across the junction
        fwd = st0.get_forward_vector()
        pos = carla.Location(st0.location.x - fwd.x * args.cam_back, st0.location.y - fwd.y * args.cam_back, st0.location.z + args.cam_height)
        cam = world.spawn_actor(cb, carla.Transform(pos, carla.Rotation(pitch=args.cam_pitch, yaw=st0.rotation.yaw)))
        cam.listen(lambda im: frame_holder.__setitem__("im", im))
        actors.append(cam)
    ctrl = Controller(jn, policy, net)
    spectator = world.get_spectator()
    spectator.set_transform(carla.Transform(jn.center + carla.Location(x=-30, y=-30, z=45), carla.Rotation(pitch=-45, yaw=45)))
    stop_t: dict[int, float] = {}
    wait_done: list[float] = []
    entered, crossed, max_q = set(), set(), 0
    zone_seen: dict[int, float] = {}
    amb_t = {}
    ticks = int(args.seconds / DT)
    warm = int(args.warmup / DT)
    t0 = time.time()
    try:
        for i in range(ticks + warm):
            world.tick()
            sim_t = (i - warm) * DT
            vs = [v for v in vehicles if v.is_alive]
            if i % 4 == 0:  # decisions/obs at 5 Hz is plenty
                for v in vs:
                    sp = v.get_velocity()
                    if math.hypot(sp.x, sp.y) < 0.5:
                        stop_t[v.id] = stop_t.get(v.id, 0.0) + 4 * DT
                    else:
                        stop_t[v.id] = 0.0
                obs, stats = observe(jn, vs, stop_t, ctrl.phase, ctrl.elapsed)
                ctrl.step(obs, stats, 4 * DT)
                if i >= warm:
                    q = stats[0]["q"] + stats[1]["q"]
                    max_q = max(max_q, q)
                    for v in vs:
                        d = v.get_location().distance(jn.center)
                        if d < ZONE_R:
                            if v.id not in entered:
                                entered.add(v.id); zone_seen[v.id] = 0.0
                            zone_seen[v.id] = zone_seen.get(v.id, 0.0) + (4 * DT if math.hypot(v.get_velocity().x, v.get_velocity().y) < 0.5 else 0.0)
                        if d < 12:
                            crossed.add(v.id)
                            if amb and v.id == amb.id and "in" not in amb_t:
                                amb_t["in"] = sim_t
                    if amb and amb.is_alive and amb.get_location().distance(jn.center) < ZONE_R and "enter" not in amb_t:
                        amb_t["enter"] = sim_t
                if cam and i % 8 == 0 and "im" in frame_holder:
                    im = frame_holder["im"]
                    arr = np.frombuffer(im.raw_data, np.uint8).reshape(im.height, im.width, 4)[:, :, :3]
                    import cv2
                    ok, jpg = cv2.imencode(".jpg", arr, [cv2.IMWRITE_JPEG_QUALITY, 80])
                    if ok:
                        backend.push("frame", jpg.tobytes(), "image/jpeg")
                    backend.push("state", json.dumps({
                        "policy": policy, "t": round(max(sim_t, 0), 1), "phase": ctrl.phase, "state": ctrl.state, "pending": ctrl.pending,
                        "axis": [stats[0], stats[1]], "switches": ctrl.switches, "queue": max(0, stats[0]["q"] + stats[1]["q"]), "vehicles": len(vs),
                        "crossed": len(crossed), "avgWait": round(float(np.mean(list(zone_seen.values()))) if zone_seen else 0.0, 2),
                    }).encode(), "application/json")
            if (i - warm) % int(20 / DT) == 0 and i >= warm:
                print(f"  [{policy}] t={sim_t:5.0f}s  crossed={len(crossed)} entered={len(entered)} queue_max={max_q} phase={ctrl.phase}/{ctrl.state}  ({(i - warm + 1) * DT / (time.time() - t0):.1f}x realtime)", flush=True)
    finally:
        if cam:
            cam.stop()
        for v in vehicles:  # unregister from the traffic manager before destroying (avoids a native abort in 0.9.16)
            try:
                v.set_autopilot(False, tm.get_port())
            except RuntimeError:
                pass
        world.tick()
        client.apply_batch_sync([carla.command.DestroyActor(a.id) for a in actors if a.is_alive], True)
        for l in jn.lights:
            l.freeze(False)
        world.tick()
        settings.synchronous_mode = False
        world.apply_settings(settings)
    waits = list(zone_seen.values())
    return {
        "policy": policy, "seconds": args.seconds, "vehicles_in_zone": len(entered), "vehicles_through_junction": len(crossed),
        "avg_wait_s": round(float(np.mean(waits)), 2) if waits else 0.0, "max_queue": max_q, "phase_changes": ctrl.switches,
        "ambulance_zone_to_junction_s": round(amb_t["in"] - amb_t["enter"], 1) if "in" in amb_t and "enter" in amb_t else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1"); ap.add_argument("--port", type=int, default=2000)
    ap.add_argument("--map", default="Town10HD_Opt"); ap.add_argument("--mode", choices=["fixed", "ai", "both"], default="both")
    ap.add_argument("--seconds", type=float, default=180); ap.add_argument("--warmup", type=float, default=20)
    ap.add_argument("--vehicles", type=int, default=70); ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--cam-height", type=float, default=9.0); ap.add_argument("--cam-pitch", type=float, default=-12.0); ap.add_argument("--cam-back", type=float, default=30.0); ap.add_argument("--cam-lane", type=int, default=0)
    ap.add_argument("--ambulance", action="store_true"); ap.add_argument("--camera", action="store_true")
    ap.add_argument("--backend", default=None, help="SignalGrid backend URL, e.g. http://127.0.0.1:8765")
    ap.add_argument("--near", type=float, nargs=2, default=(-48.0, 20.0), help="x y of the junction to use")
    ap.add_argument("--out", default="docs/carla_results.json")
    args = ap.parse_args()
    client = carla.Client(args.host, args.port); client.set_timeout(60)
    world = client.get_world()
    if args.map not in world.get_map().name:
        world = client.load_world(args.map)
    net = SignalNet.from_file("evolved")
    backend = Backend(args.backend)
    results = {}
    for mode in (["fixed", "ai"] if args.mode == "both" else [args.mode]):
        print(f"== {mode} controller", flush=True)
        results[mode] = run(world, client, args, mode, net if mode == "ai" else None, backend)
        print(json.dumps(results[mode]), flush=True)
    if len(results) == 2:
        f, a = results["fixed"], results["ai"]
        if f["avg_wait_s"]:
            print(f"avg wait: fixed {f['avg_wait_s']}s vs AI {a['avg_wait_s']}s ({(f['avg_wait_s'] - a['avg_wait_s']) / f['avg_wait_s'] * 100:+.0f}% change)")
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps({"map": args.map, "seed": args.seed, "args": vars(args), "results": results, "note": "CARLA traffic-manager traffic is only approximately repeatable between runs."}, indent=1))


if __name__ == "__main__":
    main()
