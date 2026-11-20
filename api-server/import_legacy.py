"""Import the original Indoor-Localization recordings as takes of a site.

The D-block spots in sites/bits-main came from that project's Coordinates.csv,
but its WiFi recordings (one phone CSV per spot, plus a few ESP32 takes from
07_ESP32_Collector) were only ever baked into the "legacy" model. This turns
each file into a take in the Studio's format, so the spots show their data
and the Train tab can use it.

    python import_legacy.py [site] [path/to/Indoor-Localization/02_Data]

Only 2.4 GHz access points are kept: the ESP32 can't hear 5 GHz.
Re-running skips takes that already exist.
"""

import csv
import re
import sys
from datetime import datetime
from pathlib import Path

import sites
from training import COLUMNS

SITE = sys.argv[1] if len(sys.argv) > 1 else "bits-main"
DATA = Path(sys.argv[2]) if len(sys.argv) > 2 else sites.ROOT.parent / "Indoor-Localization" / "02_Data"


def norm(label: str) -> str:
    return re.sub(r"[^a-z0-9]", "", label.lower())


def convert(src: Path, spot_ids: dict[str, str], device_default: str) -> list[tuple[str, list[list]]]:
    """One source file -> [(take id, rows)], split by its Take column if it has one."""
    takes: dict[tuple[str, str], dict] = {}   # (take number, spot) -> id, start, scans, rows
    with src.open(newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            if int(float(r.get("Frequency") or 2400)) > 3000:
                continue
            spot = spot_ids.get(norm(r["Location Label"]))
            if spot is None:
                raise KeyError(r["Location Label"])
            ts = datetime.fromisoformat(r["Timestamp"])
            t = takes.setdefault((r.get("Take") or "1", spot),
                                 {"id": sites.take_id(ts, spot), "start": ts, "scans": {}, "rows": []})
            scan = t["scans"].setdefault(r["Timestamp"], len(t["scans"]))
            t["rows"].append([t["id"], r.get("Device") or device_default, spot, scan,
                              round((ts - t["start"]).total_seconds(), 2), r["BSSID"].lower(), int(float(r["RSSI"]))])
    return [(t["id"], t["rows"]) for t in takes.values()]


def main() -> None:
    site = sites.load(SITE)
    # Match labels loosely: "DLT-8/1" in the ESP32 files is spot "DLT8_1"
    spot_ids = {norm(s["id"]): s["id"] for s in site["spots"]}
    out = sites.recordings(SITE)
    sources = [(p, "phone") for p in sorted((DATA / "01_Wifi_Daytime").glob("*.csv"))]
    sources += [(p, "esp32") for p in sorted((DATA / "05_Wifi_ESP32").glob("*.csv"))]
    added = skipped = 0
    for src, device in sources:
        try:
            takes = convert(src, spot_ids, device)
        except KeyError as e:
            print(f"  skip {src.name}: no spot matches label {e}")
            continue
        for tid, rows in takes:
            dest = out / f"{tid}.csv"
            if dest.exists() or not rows:
                skipped += 1
                continue
            with dest.open("w", newline="") as f:
                w = csv.writer(f)
                w.writerow(COLUMNS)
                w.writerows(rows)
            added += 1
            print(f"  {tid}: {len({r[3] for r in rows})} scans, {len({r[5] for r in rows})} APs ({rows[0][1]})")
    print(f"{added} takes added, {skipped} already there")


if __name__ == "__main__":
    main()
