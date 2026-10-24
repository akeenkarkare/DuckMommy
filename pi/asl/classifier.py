"""Sign classifiers: feature matrix (FRAMES, N_FEATURES) -> which sign it was.

Two interchangeable models, both CPU-only and both trained in seconds:

  TemplateClassifier  (default, models/asl_templates.npz)
      Nearest neighbours with dynamic time warping (DTW). Every recorded sample
      is a template; a new sign is compared with all of them. Works from about
      5 samples per sign, and adding a sign is just recording it. Rejects
      movements that are far from every template ("not a sign").

  MlpClassifier       (optional, models/asl_mlp.pkl, needs scikit-learn)
      A small neural network on the flattened features. Needs more samples
      (20+ per sign, plus augmentation) but copes better with new signers.

Labels that start with "_" (like "_other": scratching your nose, drinking,
typing) are recorded on purpose so the model has somewhere to put
non-signs; they are never reported as a sign.
"""

from __future__ import annotations

import json
import pickle
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from features import FRAMES, N_FEATURES, sequence_features
from landmarks import mirror


@dataclass
class Prediction:
    label: str | None  # None = not confident, or a "_" class
    score: float  # 0..1, higher = more sure
    raw_label: str  # best guess even when rejected, for the debug view
    alternatives: list = field(default_factory=list)  # [(label, score), ...]

    def as_dict(self):
        return {
            "label": self.label,
            "score": round(self.score, 3),
            "raw_label": self.raw_label,
            "alternatives": [(l, round(s, 3)) for l, s in self.alternatives],
        }


def is_noise(label: str) -> bool:
    return label.startswith("_")


# ---- DTW nearest neighbours -------------------------------------------------
def dtw_many(query: np.ndarray, templates: np.ndarray, band: int = 5) -> np.ndarray:
    """DTW distance from one (T, D) query to each of K (T, D) templates at once.

    Uses a Sakoe-Chiba band: frame i may only match frames i-band..i+band, so a
    sign can be a bit faster or slower but not reordered.
    """
    k, t, _ = templates.shape
    qq = (query**2).sum(1)  # (T,)
    tt = (templates**2).sum(2)  # (K, T)
    cross = np.einsum("id,kjd->kij", query, templates)
    d = np.sqrt(np.maximum(qq[None, :, None] + tt[:, None, :] - 2 * cross, 0))
    acc = np.full((k, t + 1, t + 1), np.inf)
    acc[:, 0, 0] = 0
    for i in range(1, t + 1):
        for j in range(max(1, i - band), min(t, i + band) + 1):
            best = np.minimum(np.minimum(acc[:, i - 1, j], acc[:, i, j - 1]), acc[:, i - 1, j - 1])
            acc[:, i, j] = d[:, i - 1, j - 1] + best
    return acc[:, t, t] / (2 * t)


class TemplateClassifier:
    kind = "templates"

    def __init__(self, band: int = 5, min_margin: float = 0.08, reject_factor: float = 2.0):
        self.band = band
        self.min_margin = min_margin  # 1 - best/second-best class distance
        self.reject_factor = reject_factor
        self.templates = np.zeros((0, FRAMES, N_FEATURES), dtype=np.float32)
        self.labels: list[str] = []
        self.reject_distance = np.inf

    def fit(self, feats: list[np.ndarray], labels: list[str], groups: list[str] | None = None):
        self.templates = np.stack(feats).astype(np.float32)
        self.labels = list(labels)
        groups = np.array(groups if groups is not None else range(len(labels)))
        # How far is a sample from its closest same-sign neighbour? Anything much
        # further than that from every template is probably not a sign at all.
        nearest = []
        lab = np.array(self.labels)
        for i, f in enumerate(self.templates):
            same = np.flatnonzero((lab == lab[i]) & (groups != groups[i]))  # skip its own mirror copy
            if len(same) and not is_noise(lab[i]):
                nearest.append(dtw_many(f, self.templates[same], self.band).min())
        if nearest:
            self.reject_distance = float(np.percentile(nearest, 90) * self.reject_factor)
        return self

    def class_distances(self, feat: np.ndarray) -> dict:
        d = dtw_many(feat, self.templates, self.band)
        out = {}
        for label, dist in zip(self.labels, d):
            out[label] = min(out.get(label, np.inf), float(dist))
        return out

    def predict(self, feat: np.ndarray) -> Prediction:
        dists = sorted(self.class_distances(feat).items(), key=lambda kv: kv[1])
        best, d1 = dists[0]
        d2 = dists[1][1] if len(dists) > 1 else d1 * 2 + 1e-6
        margin = float(1 - d1 / max(d2, 1e-9))
        # Score: margin over the runner-up, and 0 once past the reject distance.
        closeness = float(np.clip(1 - d1 / self.reject_distance, 0, 1)) if np.isfinite(self.reject_distance) else 1.0
        score = float(np.clip(0.5 * closeness + 0.5 * min(margin / 0.3, 1.0), 0, 1))
        accepted = d1 <= self.reject_distance and margin >= self.min_margin and not is_noise(best)
        # Per-class closeness for the debug view: 1 = identical, 0 = at the reject distance.
        alts = [(l, float(np.clip(1 - d / self.reject_distance, 0, 1)) if np.isfinite(self.reject_distance) else 1.0)
                for l, d in dists[:3]]
        return Prediction(best if accepted else None, score, best, alts)

    def save(self, path):
        meta = {"band": self.band, "min_margin": self.min_margin, "reject_factor": self.reject_factor,
                "reject_distance": self.reject_distance, "labels": self.labels}
        np.savez_compressed(path, templates=self.templates, meta=json.dumps(meta))

    @classmethod
    def load(cls, path):
        z = np.load(path)
        meta = json.loads(str(z["meta"]))
        c = cls(meta["band"], meta["min_margin"], meta["reject_factor"])
        c.templates, c.labels, c.reject_distance = z["templates"], meta["labels"], meta["reject_distance"]
        return c


# ---- small neural network ---------------------------------------------------
class MlpClassifier:
    kind = "mlp"

    def __init__(self, min_prob: float = 0.6, hidden=(256, 128), seed: int = 0):
        self.min_prob = min_prob
        self.hidden = hidden
        self.seed = seed
        self.model = None

    def fit(self, feats, labels, groups=None):
        from sklearn.neural_network import MLPClassifier
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import StandardScaler

        x = np.stack(feats).reshape(len(feats), -1)
        self.model = make_pipeline(
            StandardScaler(),
            MLPClassifier(self.hidden, alpha=1e-2, max_iter=600, early_stopping=False, random_state=self.seed),
        )
        self.model.fit(x, labels)
        return self

    def predict(self, feat):
        p = self.model.predict_proba(feat.reshape(1, -1))[0]
        order = np.argsort(p)[::-1]
        classes = self.model.classes_
        best, prob = str(classes[order[0]]), float(p[order[0]])
        accepted = prob >= self.min_prob and not is_noise(best)
        alts = [(str(classes[i]), float(p[i])) for i in order[:3]]
        return Prediction(best if accepted else None, prob, best, alts)

    @property
    def labels(self):
        return [str(c) for c in self.model.classes_]

    def save(self, path):
        with open(path, "wb") as f:
            pickle.dump({"min_prob": self.min_prob, "model": self.model}, f)

    @classmethod
    def load(cls, path):
        with open(path, "rb") as f:
            d = pickle.load(f)
        c = cls(d["min_prob"])
        c.model = d["model"]
        return c


def load_classifier(path):
    path = Path(path)
    if path.suffix == ".npz":
        return TemplateClassifier.load(path)
    if path.suffix == ".pkl":
        return MlpClassifier.load(path)
    raise ValueError(f"unknown model type: {path}")


# ---- data -------------------------------------------------------------------
def augment(seq: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """A slightly different copy of a raw (T, 75, 3) sample: trimmed ends,
    small rotation and jitter. Used by the MLP, which wants more data."""
    t = len(seq)
    a = rng.integers(0, max(1, int(t * 0.12)) + 1)
    b = t - rng.integers(0, max(1, int(t * 0.12)) + 1)
    s = seq[a:b] if b - a >= 4 else seq
    angle = rng.normal(0, np.radians(5))
    c, si = np.cos(angle), np.sin(angle)
    out = s.copy()
    x, y = s[..., 0], s[..., 1]
    out[..., 0], out[..., 1] = c * x - si * y, si * x + c * y
    out[..., :2] += rng.normal(0, 0.003, out[..., :2].shape)
    return out


def _variants(data_dir, use_mirror: bool):
    """(gloss, file, raw sample) for every data/<GLOSS>/*.npy, plus a mirrored copy."""
    for gloss_dir in sorted(Path(data_dir).iterdir()):
        if not gloss_dir.is_dir():
            continue
        for f in sorted(gloss_dir.glob("*.npy")):
            raw = np.load(f)
            for variant in ([raw, mirror(raw)] if use_mirror else [raw]):
                yield gloss_dir.name, str(f), variant


def _collect(items):
    feats, labels, groups = [], [], []
    for gloss, group, seq in items:
        feat = sequence_features(seq)
        if feat is not None:
            feats.append(feat)
            labels.append(gloss)
            groups.append(group)
    return feats, labels, groups


def load_samples(data_dir, use_mirror: bool = True):
    """data/<GLOSS>/*.npy -> features, labels, groups (one group per file)."""
    return _collect(_variants(data_dir, use_mirror))


def train(feats, labels, groups=None, kind: str = "templates"):
    """Fit the chosen model on already-loaded samples."""
    model = TemplateClassifier() if kind == "templates" else MlpClassifier()
    return model.fit(feats, labels, groups)


def train_from_dir(data_dir, kind: str = "templates", use_mirror: bool = True):
    feats, labels, groups = load_samples(data_dir, use_mirror)
    if len(set(labels)) < 2:
        raise ValueError("record at least two different signs first")
    if kind == "mlp":
        # The network wants more data: add 4 augmented copies of every sample.
        rng = np.random.default_rng(0)
        extra = load_augmented(data_dir, rng, copies=4, use_mirror=use_mirror)
        feats, labels, groups = feats + extra[0], labels + extra[1], groups + extra[2]
    return train(feats, labels, groups, kind), len(feats)


def load_augmented(data_dir, rng, copies=4, use_mirror=True):
    return _collect((g, f, augment(v, rng)) for g, f, v in _variants(data_dir, use_mirror) for _ in range(copies))
