"""Match our glosses (phrases.json) to the sign names public datasets use.

Used by kaggle_to_samples.py and videos_to_samples.py --citizen.
Datasets spell signs their own way ("thank you", "mine / my", "THANKYOU"), so
names are compared after dropping case, spaces and punctuation. ALIASES covers
signs a dataset files under another English word for the same ASL sign.
Stdlib only.
"""

from __future__ import annotations

import csv
import re
from collections import defaultdict
from itertools import zip_longest
from pathlib import Path

# our gloss -> other names for the SAME sign (not just a similar meaning)
ALIASES = {
    "MY": ["mine / my", "mine"],
    "EAT": ["food"],                     # EAT and FOOD are one sign (flat O hand to the mouth)
    "BATHROOM": ["potty", "toilet"],     # T hand shaken: the same sign
    "PHONE": ["call (on phone)", "call"],  # Y hand at the ear
    "FINISH": ["done", "finished"],
    "REST": ["relax"],
    "ME": ["i"],
}


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def match_glosses(dataset_names, glosses) -> dict[str, str]:
    """{our gloss: dataset name} for every gloss the dataset has. `_` classes are skipped."""
    by_norm = {}
    for name in dataset_names:
        by_norm.setdefault(norm(name), name)
    found = {}
    for gloss in glosses:
        if gloss.startswith("_"):
            continue
        for candidate in [gloss] + ALIASES.get(gloss, []):
            if norm(candidate) in by_norm:
                found[gloss] = by_norm[norm(candidate)]
                break
    return found


def safe_who(prefix: str, person) -> str:
    """File-name-safe signer id; train.py groups samples by the part before the first '-'."""
    return prefix + re.sub(r"[^A-Za-z0-9]", "", str(person))


# ---- ASL Citizen ------------------------------------------------------------------
def _column(fields, *words):
    for f in fields:
        if any(w in f.lower() for w in words):
            return f
    return None


def citizen_clips(root, glosses, per_sign: int) -> tuple[dict[str, list[tuple[str, object]]], list[str]]:
    """Find our signs in an unzipped ASL Citizen download.

    Reads every split CSV under `root`, finding the gloss, video and participant
    columns by name (they aren't documented, so this doesn't assume exact
    spellings), and matches glosses after dropping a numeric suffix (HELLO1 ->
    HELLO) as well. Returns ({our gloss: [(signer, video path), ...]}, glosses
    it didn't find); up to per_sign clips per sign, one signer at a time.
    """
    root = Path(root)
    videos = {p.name: p for p in root.rglob("*.mp4")}
    rows = []
    for path in sorted(root.rglob("*.csv")):
        with open(path, newline="") as f:
            reader = csv.DictReader(f)
            fields = reader.fieldnames or []
            g, v, who = _column(fields, "gloss"), _column(fields, "video", "file"), _column(fields, "participant", "user")
            if g and v:
                rows += [(r[g], r[v], r.get(who, "") if who else "") for r in reader]

    names = {name for name, _, _ in rows}
    stripped = {re.sub(r"\d+$", "", n): n for n in names}       # HELLO1 -> HELLO (first wins)
    found = match_glosses(names, glosses)
    for gloss, name in match_glosses(stripped, glosses).items():
        found.setdefault(gloss, stripped[name])

    by_name = defaultdict(lambda: defaultdict(list))
    for name, video, who in rows:
        path = videos.get(Path(video).name)
        if path is not None:
            by_name[name][who].append((who, path))
    clips = {}
    for gloss, name in found.items():
        rounds = zip_longest(*by_name[name].values())
        picked = [c for rnd in rounds for c in rnd if c is not None][:per_sign]
        if picked:
            clips[gloss] = picked
    missing = [g for g in glosses if g not in clips and not g.startswith("_")]
    return clips, missing
