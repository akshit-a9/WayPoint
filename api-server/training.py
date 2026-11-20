"""Train and run one fingerprint model per site.

Recordings are CSVs with one row per access point per scan:
    take, device, spot, scan, t, bssid, rssi

Validation holds out whole takes (GroupKFold on the take), so the score says
how well a *new visit* to a spot is recognised, not how well the model
remembers scans from the same 90 s. Because spots have positions in metres,
errors are reported as distances too.
"""

import csv
import math
import time
from collections import defaultdict

import joblib
import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import GroupKFold

import sites

MISSING_RSSI = -100.0
MIN_SCANS_PER_AP = 3
COLUMNS = ["take", "device", "spot", "scan", "t", "bssid", "rssi"]


def load_scans(site_id: str) -> list[dict]:
    """Every scan of every take: {take, spot, aps: {bssid: rssi}}."""
    scans: dict[tuple, dict] = {}
    for f in sorted(sites.recordings(site_id).glob("*.csv")):
        for row in csv.DictReader(f.open()):
            key = (row["take"], row["scan"])
            s = scans.setdefault(key, {"take": row["take"], "spot": row["spot"], "aps": {}})
            s["aps"][row["bssid"].lower()] = float(row["rssi"])
    return list(scans.values())


def _features(scans, bssids):
    X = np.full((len(scans), len(bssids)), MISSING_RSSI, dtype=np.float32)
    col = {b: i for i, b in enumerate(bssids)}
    for r, s in enumerate(scans):
        for b, v in s["aps"].items():
            if b in col:
                X[r, col[b]] = v
    return X


def train(site_id: str) -> dict:
    site = sites.load(site_id)
    pos = {s["id"]: (s["x"], s["y"]) for s in site["spots"] if s.get("x") is not None}
    scans = [s for s in load_scans(site_id) if s["spot"] in pos]
    takes = sorted({s["take"] for s in scans})
    spots = sorted({s["spot"] for s in scans})
    if len(spots) < 2:
        raise ValueError("Record at least 2 spots before training.")

    seen = defaultdict(int)
    for s in scans:
        for b in s["aps"]:
            seen[b] += 1
    bssids = sorted(b for b, n in seen.items() if n >= MIN_SCANS_PER_AP)
    X, y = _features(scans, bssids), np.array([s["spot"] for s in scans])
    groups = np.array([s["take"] for s in scans])

    def make():
        return RandomForestClassifier(n_estimators=200, n_jobs=-1, random_state=0)

    # Held-out-take predictions for every scan
    pred = np.empty(len(y), dtype=object)
    folds = min(5, len(takes))
    if folds >= 2:
        for tr, te in GroupKFold(n_splits=folds).split(X, y, groups):
            pred[te] = make().fit(X[tr], y[tr]).predict(X[te])
    errors = [math.dist(pos[a], pos[b]) for a, b in zip(y, pred) if b is not None]

    per_spot = []
    for sp in spots:
        m = y == sp
        e = [math.dist(pos[sp], pos[p]) for p in pred[m] if p is not None]
        per_spot.append({
            "spot": sp,
            "scans": int(m.sum()),
            "takes": len({g for g in groups[m]}),
            "accuracy": round(float(np.mean(pred[m] == sp)), 3) if e else None,
            "meanError": round(float(np.mean(e)), 2) if e else None,
            "confusedWith": (max(set(pred[m]) - {sp}, key=list(pred[m]).count, default=None) if e else None),
        })

    model = make().fit(X, y)
    model.n_jobs = 1
    # max + 1, not count + 1: models can be deleted
    version = f"v{max((int(p.stem[1:]) for p in sites.models(site_id).glob('v*.joblib')), default=0) + 1}"
    metrics = {
        "version": version,
        "trainedAt": time.strftime("%Y-%m-%d %H:%M"),
        "scans": len(scans), "takes": len(takes), "spots": len(spots), "accessPoints": len(bssids),
        "validation": f"GroupKFold by take, {folds} folds" if folds >= 2 else "none (only one take)",
        "accuracy": round(float(np.mean(pred == y)), 3) if errors else None,
        "meanError": round(float(np.mean(errors)), 2) if errors else None,
        "p90Error": round(float(np.percentile(errors, 90)), 2) if errors else None,
        "perSpot": per_spot,
    }
    joblib.dump({"model": model, "feature_bssids": bssids, "metrics": metrics},
                sites.models(site_id) / f"{version}.joblib")
    site["activeModel"] = version
    sites.save(site_id, site)
    return metrics


def list_models(site_id: str) -> list[dict]:
    out = []
    for f in sorted(sites.models(site_id).glob("v*.joblib"), key=lambda p: int(p.stem[1:])):
        out.append(_load(site_id, f.stem)["metrics"])
    return out


_cache: dict[tuple, dict] = {}


def _load(site_id: str, version: str) -> dict:
    key = (site_id, version)
    if key not in _cache:
        _cache[key] = joblib.load(sites.models(site_id) / f"{version}.joblib")
    return _cache[key]


def predict(site_id: str, version: str, scan: dict[str, float], site: dict) -> dict:
    b = _load(site_id, version)
    heard = {k.lower(): v for k, v in scan.items()}
    X = _features([{"aps": heard}], b["feature_bssids"])
    proba = b["model"].predict_proba(X)[0]
    order = np.argsort(proba)[::-1][:5]
    top = [{"spot": str(b["model"].classes_[i]), "p": round(float(proba[i]), 3)} for i in order]
    # Position between the best candidates, weighted by probability
    spots = {s["id"]: s for s in site["spots"]}
    w = [(spots[t["spot"]], t["p"]) for t in top[:3] if t["spot"] in spots]
    tot = sum(p for _, p in w) or 1
    xy = [round(sum(s["x"] * p for s, p in w) / tot, 2), round(sum(s["y"] * p for s, p in w) / tot, 2)] if w else None
    best = spots.get(top[0]["spot"], {})
    return {
        "location": best.get("name", top[0]["spot"]),
        "spot": top[0]["spot"],
        "confidence": top[0]["p"],
        "known_aps": sum(1 for x in b["feature_bssids"] if x in heard),
        "total_aps": len(b["feature_bssids"]),
        "floor": best.get("floor"),
        "xy": xy,
        "top": top,
    }
