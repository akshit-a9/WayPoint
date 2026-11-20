"""Site packs: one folder per building, so the same server can map, train and
localize in the hostel first and the main building later.

    sites/<id>/                  tracked in git
    private/sites/<id>/          git-ignored (e.g. traced from the campus plan)
        site.json                floors, outline, walkable areas, spots, destinations
        recordings/<take>.csv    one labelled 90 s take per file
        models/<version>.joblib  trained models; site.json names the active one

Positions are metres in a local frame: x east, y north, origin at
site["anchor"] (lat/lon), turned by anchor["rotation"] degrees clockwise.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE_DIRS = [ROOT / "sites", ROOT / "private" / "sites"]
ACTIVE_FILE = ROOT / "sites" / "active.txt"


def _folders() -> dict[str, Path]:
    found = {}
    for base in SITE_DIRS:
        if base.exists():
            for d in sorted(base.iterdir()):
                if (d / "site.json").exists():
                    found[d.name] = d
    return found


def folder(site_id: str) -> Path:
    d = _folders().get(site_id)
    if d is None:
        raise KeyError(site_id)
    return d


def list_sites() -> list[dict]:
    out = []
    for sid, d in _folders().items():
        s = load(sid)
        out.append({
            "id": sid,
            "name": s["name"],
            "private": "private" in d.parts,
            "spots": len(s["spots"]),
            "takes": len(list((d / "recordings").glob("*.csv"))) if (d / "recordings").exists() else 0,
            "activeModel": s.get("activeModel"),
        })
    return out


def load(site_id: str) -> dict:
    return json.loads((folder(site_id) / "site.json").read_text())


def save(site_id: str, site: dict) -> None:
    site["id"] = site_id
    (folder(site_id) / "site.json").write_text(json.dumps(site, indent=1))


def trash(site_id: str) -> Path:
    """Move a site pack (recordings and models too) to <base>/.trash/ instead of deleting it."""
    import time
    d = folder(site_id)
    dest = d.parent / ".trash" / f"{site_id}_{time.strftime('%Y%m%d-%H%M%S')}"
    dest.parent.mkdir(exist_ok=True)
    d.rename(dest)
    return dest


def take_id(when, spot: str) -> str:
    """File-safe take id: spot ids can contain '/' or spaces ("D-151/1 Computation Lab")."""
    import re
    return f"{when:%Y%m%d-%H%M%S}_" + re.sub(r"[^A-Za-z0-9_-]+", "_", spot).strip("_")


def recordings(site_id: str) -> Path:
    d = folder(site_id) / "recordings"
    d.mkdir(exist_ok=True)
    return d


def models(site_id: str) -> Path:
    d = folder(site_id) / "models"
    d.mkdir(exist_ok=True)
    return d


def active() -> str:
    sid = ACTIVE_FILE.read_text().strip() if ACTIVE_FILE.exists() else ""
    return sid if sid in _folders() else next(iter(_folders()), "")


def set_active(site_id: str) -> None:
    folder(site_id)  # raises if unknown
    ACTIVE_FILE.write_text(site_id + "\n")
