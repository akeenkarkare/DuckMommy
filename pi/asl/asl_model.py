"""Files the word-sign engine needs: phrases.json, the trained model, recorded samples.

  engine, model_path = make_engine()     # what duck.py and run.py both use,
                                         # so live and recorded signs are cut the same way
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

from asl_engine import AslEngine, Config
from classifier import load_classifier

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "data"
MODELS = [HERE / "models" / "asl_templates.npz", HERE / "models" / "asl_mlp.pkl"]
PHRASES = HERE / "phrases.json"


def load_model(path: str | Path | None = None):
    """(classifier, path), or (None, None) until train.py has run: nothing is
    recognised then, but recording still works."""
    for p in [Path(path)] if path else MODELS:
        if p.exists():
            return load_classifier(p), p
    return None, None


def make_engine(rest_line: float = Config.rest_line, model: str | Path | None = None, on_sample=None):
    classifier, path = load_model(model)
    vocab = json.loads(PHRASES.read_text())
    return AslEngine(classifier, vocab, Config(rest_line=rest_line), on_sample=on_sample), path


def save_sample(gloss: str, seq: np.ndarray, who: str):
    """data/<GLOSS>/<who>-<time>.npy; the name prefix lets train.py test on unseen signers."""
    folder = DATA_DIR / gloss
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{who}-{time.strftime('%Y%m%d-%H%M%S')}-{int(time.time() * 1000) % 1000:03d}.npy"
    np.save(path, seq.astype(np.float32))
    print(f"# recorded {gloss}: {path.name} ({len(seq)} frames)", file=sys.stderr)
