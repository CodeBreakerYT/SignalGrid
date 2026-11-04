"""Compose the 3:2 project thumbnail from real captures (CARLA frame + YOLO + SignalGrid 3D sim).
python tools/make_thumbnail.py <carla_frame.jpg> <sim3d.jpg> <out.png>
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ultralytics import YOLO  # noqa: E402

carla_p, sim_p, out_p = sys.argv[1:4]
W, H = 1800, 1200
COL = {"car": (0, 243, 255), "truck": (255, 176, 32), "bus": (255, 43, 214), "motorcycle": (49, 255, 154), "person": (255, 230, 109)}

# --- YOLO on the CARLA frame, drawn in the reference monitor's style (corner brackets + filled tags)
img = cv2.imread(carla_p)
res = YOLO(str(Path(__file__).resolve().parent.parent / "backend/models/yolov8n.pt")).predict(img, conf=0.25, classes=[0, 2, 3, 5, 7], verbose=False)[0]
names = {0: "person", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
counts = {}
for b in res.boxes:
    x1, y1, x2, y2 = map(int, b.xyxy[0]); c = names[int(b.cls[0])]; col = COL[c][::-1]; counts[c] = counts.get(c, 0) + 1
    cv2.rectangle(img, (x1, y1), (x2, y2), col, 1)
    tk = max(8, min(22, (x2 - x1) // 4))
    for (cx, cy, dx, dy) in [(x1, y1, 1, 1), (x2, y1, -1, 1), (x1, y2, 1, -1), (x2, y2, -1, -1)]:
        cv2.line(img, (cx, cy), (cx + dx * tk, cy), col, 3); cv2.line(img, (cx, cy), (cx, cy + dy * tk), col, 3)
    tag = f"{c} {float(b.conf[0]):.0%}"
    (tw, th), _ = cv2.getTextSize(tag, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 1)
    cv2.rectangle(img, (x1, y1 - th - 8), (x1 + tw + 6, y1), col, -1)
    cv2.putText(img, tag, (x1 + 3, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (20, 10, 30), 1, cv2.LINE_AA)
print("detections:", counts)
yolo_im = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))

def font(sz, bold=False):
    for f in ("bahnschrift.ttf", "segoeuib.ttf" if bold else "segoeui.ttf"):
        try:
            return ImageFont.truetype(f"C:/Windows/Fonts/{f}", sz)
        except OSError:
            continue
    return ImageFont.load_default()

bg = Image.new("RGB", (W, H), (7, 8, 15))
d = ImageDraw.Draw(bg, "RGBA")
for i in range(0, W, 60):
    d.line([(i, 0), (i, H)], fill=(0, 243, 255, 12))
for j in range(0, H, 60):
    d.line([(0, j), (W, j)], fill=(0, 243, 255, 12))
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0)); g = ImageDraw.Draw(glow)
g.ellipse([-300, -300, 900, 700], fill=(163, 91, 255, 70)); g.ellipse([1100, 700, 2200, 1500], fill=(0, 243, 255, 55))
bg = Image.alpha_composite(bg.convert("RGBA"), glow.filter(ImageFilter.GaussianBlur(160))).convert("RGB")
d = ImageDraw.Draw(bg, "RGBA")

def panel(im, box, title, tag, accent):
    x, y, w, h = box
    im = im.copy(); r = max(w / im.width, h / im.height)
    im = im.resize((int(im.width * r), int(im.height * r)), Image.LANCZOS)
    im = im.crop(((im.width - w) // 2, (im.height - h) // 2, (im.width - w) // 2 + w, (im.height - h) // 2 + h))
    mask = Image.new("L", (w, h), 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], 22, fill=255)
    bg.paste(im, (x, y), mask)
    d.rounded_rectangle([x, y, x + w, y + h], 22, outline=accent + (255,), width=3)
    d.rounded_rectangle([x + 18, y + 18, x + 18 + 14 + d.textlength(title, font=font(26, True)) + 18, y + 60], 12, fill=(5, 7, 16, 215), outline=accent + (200,), width=2)
    d.text((x + 34, y + 25), title, font=font(26, True), fill=accent)
    tw = d.textlength(tag, font=font(22))
    d.rounded_rectangle([x + w - tw - 44, y + h - 56, x + w - 18, y + h - 18], 10, fill=(5, 7, 16, 215))
    d.text((x + w - tw - 32, y + h - 51), tag, font=font(22), fill=(200, 210, 255))

# header
d.text((70, 48), "SIGNALGRID", font=font(92, True), fill=(0, 243, 255))
d.text((70, 148), "Neural traffic signals, evolved by simulation", font=font(40), fill=(230, 236, 255))
d.text((70, 202), "FT-01  Smart Traffic Signal Optimisation   |   Neural Storm 2026", font=font(26), fill=(138, 147, 184))
panel(yolo_im, (70, 270, 1000, 640), "CARLA  +  YOLOv8", f"{sum(counts.values())} objects detected, live", (0, 243, 255))
panel(Image.open(sim_p).convert("RGB"), (1100, 270, 630, 400), "AI simulation (3D)", "Evolved AI controls the signals", (163, 91, 255))
# result cards
cards = [("-17%", "waiting time"), ("-38%", "pedestrian wait"), ("-36%", "ambulance delay")]
for i, (big, small) in enumerate(cards):
    x = 1100 + i * 214
    d.rounded_rectangle([x, 700, x + 202, 910], 18, fill=(15, 19, 36, 235), outline=(49, 255, 154, 150), width=2)
    d.text((x + 101, 765), big, font=font(58, True), fill=(49, 255, 154), anchor="mm")
    d.text((x + 101, 840), small, font=font(24), fill=(200, 210, 255), anchor="mm")
d.text((1100, 925), "vs fixed timer, measured in simulation (8 seeds x 8 scenarios)", font=font(22), fill=(138, 147, 184))
# footer pipeline
steps = ["Camera / CARLA", "YOLOv8 detect + track", "Neural signal agent", "Safe traffic light"]
x = 70
for i, s in enumerate(steps):
    w = int(d.textlength(s, font=font(30, True))) + 56
    d.rounded_rectangle([x, 970, x + w, 1050], 16, fill=(15, 19, 36, 240), outline=(0, 243, 255, 170), width=2)
    d.text((x + w / 2, 1010), s, font=font(30, True), fill=(230, 236, 255), anchor="mm")
    x += w
    if i < len(steps) - 1:
        d.text((x + 16, 1010), ">", font=font(40, True), fill=(163, 91, 255), anchor="mm"); x += 34
d.text((70, 1100), "Evolved AI  |  Safety layer: min green, amber, all-red, pedestrian clearance  |  Web app and Windows exe", font=font(26), fill=(138, 147, 184))
bg.save(out_p)
print("saved", out_p, bg.size)
