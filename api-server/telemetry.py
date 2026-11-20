"""Debug telemetry from the devices, so debugging needs no serial cable.

The firmware POSTs one batch per second to /api/device/telemetry: scans,
predictions, sensor samples, UI events, health and log lines. Each batch is
appended to data/sessions/<date>_<device>/telemetry.jsonl (one session per
boot) and kept in memory for the Studio's Debug tab. The reply can carry
commands back to the device (dev builds only act on them).
"""

import json
import threading
import time
from collections import deque
from pathlib import Path

SESSIONS = Path(__file__).resolve().parent.parent / "data" / "sessions"
KEEP = 600  # batches in memory per device (~10 min at 1/s)
TRAIL = 120  # smoothed positions kept for the Live map (~2 min)

_lock = threading.Lock()
_devices: dict[str, dict] = {}


def _session_dir(device: str, boot: int) -> Path:
    stamp = time.strftime("%Y-%m-%d_%H%M%S")
    d = SESSIONS / f"{stamp}_{device.replace(':', '')}_boot{boot}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def ingest(batch: dict) -> list[dict]:
    """Store one batch; return the commands waiting for this device."""
    device = str(batch.get("device", "unknown"))
    boot = int(batch.get("boot", 0))
    batch["rx"] = time.time()
    with _lock:
        d = _devices.get(device)
        if d is None or d["boot"] != boot:
            # New device or it rebooted: start a new session file
            d = {"boot": boot, "dir": _session_dir(device, boot), "batches": deque(maxlen=KEEP),
                 # seq keeps counting across reboots so the Studio's ?since= stays valid
                 "commands": d["commands"] if d else [], "seq": d["seq"] if d else 0}
            _devices[device] = d
        d["batches"].append(batch)
        if "scr" in batch:  # screen picture, sent only while the Studio asks: keep the latest
            d["screen"] = {"data": batch["scr"], "rx": batch["rx"], "format": batch.get("scrf", "1bpp"),
                           "w": batch.get("scrw", 128), "h": batch.get("scrh", 32)}
        tr = batch.get("track") or {}
        if "x" in tr:  # smoothed position (steps + WiFi): the Live map's trail
            d.setdefault("track", deque(maxlen=TRAIL)).append([tr["x"], tr["y"]])
        d["seq"] += 1
        batch["n"] = d["seq"]
        with (d["dir"] / "telemetry.jsonl").open("a") as f:
            f.write(json.dumps(batch, separators=(",", ":")) + "\n")
        cmds, d["commands"] = d["commands"], []
    return cmds


def queue_command(device: str, cmd: dict) -> None:
    with _lock:
        _devices.setdefault(device, {"boot": -1, "dir": None, "batches": deque(maxlen=KEEP), "commands": [], "seq": 0})
        _devices[device]["commands"].append(cmd)


def devices() -> list[dict]:
    now = time.time()
    with _lock:
        out = []
        for dev, d in _devices.items():
            last = d["batches"][-1] if d["batches"] else {}
            out.append({"id": dev, "boot": d["boot"], "age": round(now - last.get("rx", 0), 1) if last else None,
                        "fw": last.get("fw"), "health": last.get("health"), "ui": last.get("ui"),
                        "nav": last.get("nav"), "track": last.get("track"), "trail": list(d.get("track", [])),
                        "screen": {**{k: d["screen"][k] for k in ("data", "format", "w", "h")},
                                   "age": round(now - d["screen"]["rx"], 1)} if d.get("screen") else None,
                        "session": d["dir"].name if d["dir"] else None})
        return out


def recent(device: str, since: int = 0) -> list[dict]:
    """Batches with n > since (the Studio polls with the last n it saw)."""
    with _lock:
        d = _devices.get(device)
        return [b for b in d["batches"] if b["n"] > since] if d else []
