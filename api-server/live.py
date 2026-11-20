"""What the devices are doing right now, and labelled recording.

The WayPoint firmware already posts a scan every ~2 s, so recording needs no
firmware change: while a take is running, every scan from the chosen device
is also written to the site's recordings as that spot.
"""

import csv
import threading
import time
from collections import deque

import sites
from training import COLUMNS

_lock = threading.Lock()
devices: dict[str, dict] = {}
take: dict | None = None


def on_scan(device: str, scan: dict[str, float], result: dict, site_id: str) -> None:
    now = time.time()
    with _lock:
        d = devices.setdefault(device, {"id": device, "history": deque(maxlen=60), "scans": 0})
        d.update(lastSeen=now, site=site_id, scan=sorted(scan.items(), key=lambda kv: -kv[1]), result=result)
        d["scans"] += 1
        d["history"].append({"t": now, "xy": result.get("xy"), "spot": result.get("spot"), "floor": result.get("floor")})
        if take and take["device"] == device and not take["done"]:
            _record(scan, now)


def _record(scan: dict[str, float], now: float) -> None:
    if now - take["started"] > take["seconds"]:
        take["done"] = True
        return
    new = not take["path"].exists()
    with take["path"].open("a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(COLUMNS)
        for bssid, rssi in scan.items():
            w.writerow([take["id"], take["device"], take["spot"], take["scans"], round(now - take["started"], 2), bssid.lower(), rssi])
    take["scans"] += 1


def start_take(site_id: str, spot: str, label: str, device: str, seconds: int) -> dict:
    global take
    from datetime import datetime
    tid = sites.take_id(datetime.now(), spot)
    with _lock:
        take = {"id": tid, "site": site_id, "spot": spot, "label": label, "device": device, "seconds": seconds,
                # 8 headings, 45° apart: turn right at 1/8, 2/8 ... 7/8 of the take
                "turnEvery": seconds / 8,
                "started": time.time(), "scans": 0, "done": False,
                "path": sites.recordings(site_id) / f"{tid}.csv"}
    return take_status()


def take_for(device: str) -> dict | None:
    """What the device's screen should show: the running take, or 'saved' for a few seconds after."""
    t = take_status()
    if not t or t["device"] != device or t["elapsed"] > t["seconds"] + 6:
        return None
    return {"spot": t["label"], "elapsed": t["elapsed"], "seconds": t["seconds"],
            "turnEvery": t["turnEvery"], "scans": t["scans"], "done": t["done"]}


def cancel_take() -> None:
    global take
    with _lock:
        if take and not take["done"] and take["path"].exists():
            take["path"].unlink()
        take = None


def take_status() -> dict | None:
    if not take:
        return None
    if not take["done"] and time.time() - take["started"] > take["seconds"]:
        take["done"] = True
    return {k: v for k, v in take.items() if k != "path"} | {"elapsed": round(time.time() - take["started"], 1)}


def snapshot() -> list[dict]:
    now = time.time()
    with _lock:
        return [{**{k: v for k, v in d.items() if k != "history"}, "history": list(d["history"]),
                 "age": round(now - d["lastSeen"], 1)} for d in devices.values()]
