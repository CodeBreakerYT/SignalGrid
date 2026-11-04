"""Python port of SignalNet (web/js/core/controllers.js). Same wiring file + genome => same decisions."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

DATA = Path(__file__).resolve().parent.parent / "web" / "data"


class SignalNet:
    def __init__(self, genome: list[float] | np.ndarray, structure: dict | None = None):
        st = structure or json.loads((DATA / "net_structure.json").read_text())
        self.nIn, self.nHid, self.nOut = st["nIn"], st["nHid"], st["nOut"]
        self.N = self.nHid + self.nOut
        self.alpha, self.steps = st["alpha"], st["steps"]
        self.sign = np.array(st["sign"], np.float32)
        self.safety = st["safety"]
        g = np.asarray(genome, np.float32)
        n_win = self.nIn * self.nHid
        self.win = g[:n_win].reshape(self.nIn, self.nHid)
        mask = np.zeros(self.N * self.N, np.float32)
        mask[st["recMask"]] = 1
        self.rec = (g[n_win:n_win + self.N * self.N] * mask).reshape(self.N, self.N)  # [post, pre]
        self.theta = g[n_win + self.N * self.N:n_win + self.N * self.N + self.N]
        self.x = np.zeros(self.N, np.float32)
        self.cur_target = 0.0

    @classmethod
    def from_file(cls, which: str = "evolved") -> "SignalNet":
        if which == "evolved":
            return cls(json.loads((DATA / "evolved.json").read_text())["genome"])
        raise ValueError(which)

    def forward(self, obs: np.ndarray) -> np.ndarray:
        drive = np.zeros(self.N, np.float32)
        drive[: self.nHid] = obs @ self.win
        w_eff = self.rec * self.sign[None, :]
        x, a_ = self.x, self.alpha
        for _ in range(self.steps):
            for i in range(self.N):  # in-place sequential update, exactly like the JS implementation
                u = drive[i] - self.theta[i] + float(w_eff[i] @ x)
                act = min(max(u, 0.0), 1.0 if i < self.nHid else 3.0)
                x[i] = (1 - a_) * x[i] + a_ * act
        return self.x[self.nHid:].copy()

    def decide(self, obs: np.ndarray, cur: int, elapsed: float) -> int:
        out = self.forward(obs)
        cont = out[cur] + out[4]
        others = [k for k in range(4) if k != cur]
        best = max(others, key=lambda k: out[k])
        mn, mx = self.safety["minGreen"][cur], self.safety["maxGreen"][cur]
        if elapsed < mn + (out[5] / 3) * (mx - mn):
            return cur
        return best if out[best] > cont else cur
