"""Train a sign model from data/ and say honestly how good it is.

    python3 train.py                    # DTW templates -> models/asl_templates.npz
    python3 train.py --kind mlp         # small neural net -> models/asl_mlp.pkl (needs scikit-learn)
    python3 train.py --eval-only        # just the accuracy report

The report:
  * by sample  - 5-fold cross-validation (a sample is never tested against itself)
  * by signer  - train on everyone but one person, test on that person. This is
                 the number that predicts how a judge who signs will do. Needs
                 samples from 2+ people (the "who" part of the file name).
Then a confusion list: which signs get mixed up, so you can re-record or
swap one of them for a more distinct sign.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from classifier import load_augmented, load_samples, train

HERE = Path(__file__).resolve().parent


def evaluate(feats, labels, groups, kind, folds, data_dir):
    """folds: list of (name, test_group_set). Returns overall accuracy, confusions."""
    feats, labels, groups = np.array(feats), np.array(labels), np.array(groups)
    hits = total = rejected = 0
    confusion = Counter()
    per_class = defaultdict(lambda: [0, 0])
    for _, test_groups in folds:
        test = np.isin(groups, list(test_groups))
        if test.all() or not test.any():
            continue
        tr_f, tr_l, tr_g = list(feats[~test]), list(labels[~test]), list(groups[~test])
        if kind == "mlp":
            rng = np.random.default_rng(0)
            ef, el, eg = load_augmented(data_dir, rng, copies=4)
            keep = ~np.isin(eg, list(test_groups))
            tr_f += [f for f, k in zip(ef, keep) if k]
            tr_l += [l for l, k in zip(el, keep) if k]
            tr_g += [g for g, k in zip(eg, keep) if k]
        model = train(tr_f, tr_l, tr_g, kind)
        for f, truth in zip(feats[test], labels[test]):
            pred = model.predict(f)
            expected = None if truth.startswith("_") else truth
            got = pred.label
            per_class[truth][1] += 1
            total += 1
            if got == expected:
                hits += 1
                per_class[truth][0] += 1
            else:
                if got is None:
                    rejected += 1
                confusion[(truth, got or "(rejected)")] += 1
    return hits, total, rejected, confusion, per_class


def report(title, result):
    hits, total, rejected, confusion, per_class = result
    if not total:
        print(f"\n{title}: not enough data")
        return
    print(f"\n{title}: {hits}/{total} = {hits / total:.0%} correct ({rejected} rejected as 'not a sign')")
    for label, (h, n) in sorted(per_class.items(), key=lambda kv: kv[1][0] / kv[1][1]):
        print(f"   {label:<12} {h:>3}/{n:<3} {h / n:5.0%}")
    if confusion:
        print("   most common mistakes (truth -> predicted):")
        for (truth, got), n in confusion.most_common(8):
            print(f"     {truth} -> {got}: {n}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(HERE / "data"))
    ap.add_argument("--kind", choices=["templates", "mlp"], default="templates")
    ap.add_argument("--no-mirror", action="store_true", help="don't add left-handed copies")
    ap.add_argument("--eval-only", action="store_true")
    args = ap.parse_args()

    feats, labels, groups = load_samples(args.data, use_mirror=not args.no_mirror)
    if len(set(labels)) < 2:
        sys.exit(f"Need samples of at least 2 signs in {args.data}")
    counts = Counter(Path(g).parent.name for g in set(groups))
    print("samples per sign:", dict(sorted(counts.items())))
    low = [g for g, n in counts.items() if n < 5]
    if low:
        print("WARNING: fewer than 5 samples for", low)

    files = sorted(set(groups))
    rng = np.random.default_rng(0)
    order = rng.permutation(len(files))
    k = min(5, len(files))
    by_sample = [(f"fold{i}", {files[j] for j in order[i::k]}) for i in range(k)]
    report("by sample (5-fold)", evaluate(feats, labels, groups, args.kind, by_sample, args.data))

    people = defaultdict(set)
    for f in files:
        people[Path(f).name.split("-")[0]].add(f)
    if len(people) >= 2:
        by_person = [(p, fs) for p, fs in people.items()]
        report(f"by signer (leave one of {sorted(people)} out)",
               evaluate(feats, labels, groups, args.kind, by_person, args.data))
    else:
        print("\nby signer: record with --who <name> for 2+ people to get this number")

    if args.eval_only:
        return
    if args.kind == "mlp":
        ef, el, eg = load_augmented(args.data, np.random.default_rng(0), copies=4,
                                    use_mirror=not args.no_mirror)
        feats, labels, groups = feats + ef, labels + el, groups + eg
    model = train(feats, labels, groups, args.kind)
    out = HERE / "models" / ("asl_templates.npz" if args.kind == "templates" else "asl_mlp.pkl")
    out.parent.mkdir(exist_ok=True)
    model.save(out)
    print(f"\nsaved {out}  (restart duck.py / run.py to load it)")


if __name__ == "__main__":
    main()
