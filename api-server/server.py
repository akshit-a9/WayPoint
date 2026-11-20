"""HTTP API for the WayPoint device, plus the Studio's API under /api.

Run from this folder:
    uvicorn server:app --host 0.0.0.0 --port 8000

The device endpoints (/health, /locations, /predict) answer for the *active*
site, so switching from the hostel to the main building needs no firmware
change. The Studio (../studio) is served at /studio once built.
"""

import csv
import hashlib
import json
import time
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import live
import localizer
import sites
import stream
import telemetry
import training


@asynccontextmanager
async def lifespan(_app: FastAPI):
    udp = await stream.start()  # live sensor packets from devices
    yield
    if udp:
        udp.close()


app = FastAPI(title="WayPoint API", lifespan=lifespan)


class AccessPoint(BaseModel):
    bssid: str
    rssi: float


class ScanRequest(BaseModel):
    scans: list[AccessPoint]


def _site_or_404(site_id: str) -> dict:
    try:
        return sites.load(site_id)
    except KeyError:
        raise HTTPException(404, f"No site '{site_id}'")


def _locate(scan: dict[str, float]) -> tuple[str, dict]:
    sid = sites.active()
    site = sites.load(sid)
    version = site.get("activeModel")
    if version and version != "legacy":
        return sid, training.predict(sid, version, scan, site)
    if version == "legacy":
        return sid, _with_spot(localizer.predict(scan), site)
    return sid, {"location": "NO MODEL", "confidence": 0.0, "known_aps": 0, "total_aps": 0}


def _with_spot(result: dict, site: dict) -> dict:
    """The legacy model answers with a location name only; add the spot it names
    (by id or name), its floor and position, as trained models do. The device
    navigates from the spot id."""
    spot = next((s for s in site["spots"] if result["location"] in (s["id"], s.get("name"))), None)
    if spot:
        result.update(spot=spot["id"], floor=spot["floor"])
        if spot.get("x") is not None:
            result["xy"] = [spot["x"], spot["y"]]
    return result


# ---------------------------------------------------------------------------
# Device endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    """The ESP32 calls this at boot to check the server is up."""
    sid = sites.active()
    site = sites.load(sid)
    return {"status": "ok", "site": sid, "locations": len(site["spots"]), "model": site.get("activeModel")}


@app.get("/locations")
def locations():
    """Every location the active site can answer with."""
    return {s["id"]: s["name"] for s in sites.load(sites.active())["spots"]}


@app.post("/predict")
def predict(req: ScanRequest, request: Request):
    """Takes one WiFi scan, returns the most likely location."""
    scan = {ap.bssid: ap.rssi for ap in req.scans}
    sid, result = _locate(scan)
    # New firmware names itself by MAC; older firmware is known by its IP
    live.on_scan(request.headers.get("X-Device-Id") or request.client.host, scan, result, sid)
    print(f"[{sid}] scan of {len(scan)} APs ({result['known_aps']} known) -> "
          f"{result['location']} ({result['confidence']:.0%})")
    return result


# ---------------------------------------------------------------------------
# Studio API
# ---------------------------------------------------------------------------
class NewSite(BaseModel):
    id: str
    name: str
    private: bool = True
    lat: float
    lon: float


class Active(BaseModel):
    id: str


class TakeRequest(BaseModel):
    site: str
    spot: str
    device: str
    seconds: int = 90


@app.get("/api/sites")
def api_sites():
    return {"active": sites.active(), "sites": sites.list_sites()}


@app.post("/api/sites")
def api_new_site(s: NewSite):
    if not s.id.replace("-", "").isalnum():
        raise HTTPException(400, "Use letters, digits and dashes for the id")
    base = sites.SITE_DIRS[1 if s.private else 0] / s.id
    if base.exists():
        raise HTTPException(409, "Site already exists")
    base.mkdir(parents=True)
    site = {"schema": 1, "id": s.id, "name": s.name, "anchor": {"lat": s.lat, "lon": s.lon, "rotation": 0},
            "floors": [{"id": "0", "name": "Ground floor", "level": 0, "height": 3.2, "outline": [], "overlay": None}],
            "spots": [], "destinations": [], "edges": [], "activeModel": None}
    (base / "site.json").write_text("{}")
    sites.save(s.id, site)
    return site


@app.put("/api/active")
def api_set_active(a: Active):
    _site_or_404(a.id)
    sites.set_active(a.id)
    return {"active": a.id}


@app.get("/api/sites/{site_id}")
def api_site(site_id: str):
    return _site_or_404(site_id)


@app.put("/api/sites/{site_id}")
def api_save_site(site_id: str, site: dict):
    _site_or_404(site_id)
    sites.save(site_id, site)
    return {"saved": True}


@app.get("/api/sites/{site_id}/floors/{floor_id}/overlay")
def api_floor_plan(site_id: str, floor_id: str):
    """The floor's plan image. Only files under private/ or the site folders are served."""
    floor = next((f for f in _site_or_404(site_id)["floors"] if f["id"] == floor_id), None)
    if not floor or not floor.get("overlay"):
        raise HTTPException(404, "No floor plan")
    path = (sites.ROOT / floor["overlay"]["image"]).resolve()
    allowed = [(sites.ROOT / "private").resolve(), *(d.resolve() for d in sites.SITE_DIRS)]
    if not any(path.is_relative_to(a) for a in allowed) or not path.is_file():
        raise HTTPException(404, "No floor plan")
    return FileResponse(path, headers={"Cache-Control": "max-age=3600"})


@app.delete("/api/sites/{site_id}")
def api_delete_site(site_id: str):
    _site_or_404(site_id)
    return {"trashed": str(sites.trash(site_id).relative_to(sites.ROOT))}


@app.get("/api/sites/{site_id}/recordings")
def api_recordings(site_id: str):
    _site_or_404(site_id)
    takes = []
    for f in sorted(sites.recordings(site_id).glob("*.csv")):
        rows = list(csv.DictReader(f.open()))
        if rows:
            takes.append({"take": f.stem, "spot": rows[0]["spot"], "device": rows[0]["device"],
                          "scans": len({r["scan"] for r in rows}), "aps": len({r["bssid"] for r in rows})})
    per_spot = Counter(t["spot"] for t in takes)
    return {"takes": takes, "perSpot": per_spot}


@app.delete("/api/sites/{site_id}/recordings/{take}")
def api_delete_take(site_id: str, take: str):
    f = sites.recordings(site_id) / f"{Path(take).name}.csv"
    if not f.exists():
        raise HTTPException(404, "No such take")
    f.unlink()
    return {"deleted": take}


@app.post("/api/sites/{site_id}/train")
def api_train(site_id: str):
    _site_or_404(site_id)
    try:
        return training.train(site_id)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/sites/{site_id}/models")
def api_models(site_id: str):
    site = _site_or_404(site_id)
    return {"active": site.get("activeModel"), "models": training.list_models(site_id)}


@app.put("/api/sites/{site_id}/models/active")
def api_activate_model(site_id: str, a: Active):
    site = _site_or_404(site_id)
    site["activeModel"] = a.id
    sites.save(site_id, site)
    return {"active": a.id}


@app.delete("/api/sites/{site_id}/models/{version}")
def api_delete_model(site_id: str, version: str):
    site = _site_or_404(site_id)
    f = sites.models(site_id) / f"{Path(version).name}.joblib"
    if not f.exists():
        raise HTTPException(404, "No such model")
    f.unlink()
    if site.get("activeModel") == version:
        site["activeModel"] = None
        sites.save(site_id, site)
    return {"deleted": version}


# Per-device settings the Studio works out (compass calibration, how the
# device is held). Kept on the server so the firmware can fetch them later.
DEVICES = sites.ROOT / "data" / "devices"


def _device_file(device: str) -> Path:
    return DEVICES / (device.replace(":", "").replace("/", "") + ".json")


@app.get("/api/devices/{device}/orientation")
def api_get_orientation(device: str):
    f = _device_file(device)
    return json.loads(f.read_text()) if f.exists() else {}


@app.put("/api/devices/{device}/orientation")
def api_put_orientation(device: str, cfg: dict):
    DEVICES.mkdir(parents=True, exist_ok=True)
    _device_file(device).write_text(json.dumps(cfg, indent=1))
    return {"saved": True}


@app.get("/api/live")
def api_live():
    return {"active": sites.active(), "devices": live.snapshot(), "take": live.take_status()}


@app.post("/api/take")
def api_start_take(t: TakeRequest):
    site = _site_or_404(t.site)
    spot = next((s for s in site["spots"] if s["id"] == t.spot), None)
    if spot is None:
        raise HTTPException(400, "Unknown spot")
    return live.start_take(t.site, t.spot, spot.get("name") or t.spot, t.device, t.seconds)


@app.delete("/api/take")
def api_cancel_take():
    live.cancel_take()
    return {"cancelled": True}


# ---------------------------------------------------------------------------
# Navigation pack: what the device needs to route on its own
# ---------------------------------------------------------------------------
VIA = {"stairs": 1, "lift": 2, "ramp": 3}


def _nav_pack(device: str) -> dict:
    """The active site's placed spots, the links between them and the device's
    compass calibration, in compact arrays. `v` changes whenever any of it does.

    spots: [id, name, floor index, x, y, is destination]   (metres, site frame)
    edges: [spot index a, spot index b, via (0 same floor, 1 stairs, 2 lift, 3 ramp), length m]
    floors: [name, level]; rot: add to a site-frame bearing for the compass bearing
    cal: [offX, offY, offZ, scaleX, scaleY, scaleZ, vertical axis, mirror, heading offset] or null
    Lengths match the Studio's graph.ts: straight line, plus the climb unless by lift.
    """
    sid = sites.active()
    site = sites.load(sid)
    floors = sorted(site["floors"], key=lambda f: f["level"])
    fidx = {f["id"]: i for i, f in enumerate(floors)}
    elev = {f["id"]: sum(g["height"] for g in floors if g["level"] < f["level"]) for f in floors}
    spots = [s for s in site["spots"] if s.get("x") is not None and s["floor"] in fidx]
    idx = {s["id"]: i for i, s in enumerate(spots)}
    edges = []
    for e in site.get("edges", []):
        if e["a"] in idx and e["b"] in idx:
            a, b = spots[idx[e["a"]]], spots[idx[e["b"]]]
            climb = 0 if e.get("via") == "lift" else abs(elev[a["floor"]] - elev[b["floor"]])
            length = ((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5 + climb
            edges.append([idx[e["a"]], idx[e["b"]], VIA.get(e.get("via"), 0), round(length, 2)])
    cal = None
    f = _device_file(device) if device else None
    if f and f.exists():
        o = json.loads(f.read_text())
        if o.get("calibratedAt"):
            cal = [*o["magOffset"], *[round(v, 4) for v in o["magScale"]], o["magVertical"],
                   1 if o.get("mirror") else 0, round(o.get("headingOffset", 0), 2)]
    pack = {
        "site": sid, "rot": site["anchor"].get("rotation", 0),
        "floors": [[f["name"], f["level"]] for f in floors],
        "spots": [[s["id"], (s.get("name") or s["id"])[:23], fidx[s["floor"]], round(s["x"], 2), round(s["y"], 2),
                   1 if s.get("dest") else 0] for s in spots],
        "edges": edges, "cal": cal,
    }
    pack["v"] = hashlib.sha1(json.dumps(pack, sort_keys=True).encode()).hexdigest()[:8]
    return pack


@app.get("/api/device/nav")
def api_nav_pack(request: Request):
    return _nav_pack(request.headers.get("X-Device-Id", ""))


FIRMWARE = Path(__file__).resolve().parent.parent / "firmware" / "build" / "waypoint.ino.bin"


@app.get("/api/device/firmware")
def api_firmware():
    """The latest build, for a device told to "update" (firmware/flash-wifi.ps1 puts it here)."""
    if not FIRMWARE.exists():
        raise HTTPException(404, "No firmware built: run firmware/flash-wifi.ps1")
    return FileResponse(FIRMWARE, media_type="application/octet-stream")


COREDUMPS = Path(__file__).resolve().parent.parent / "data" / "coredumps"


@app.post("/api/device/coredump")
async def api_coredump(request: Request):
    """A crash dump the device found in flash after a crash (ESP-IDF ELF core dump).
    Decode it with the crashing build's .elf: xtensa-esp32-elf-gdb <elf> <dump>."""
    import time
    body = await request.body()
    dev = request.headers.get("X-Device-Id", "unknown").replace(":", "")
    COREDUMPS.mkdir(parents=True, exist_ok=True)
    path = COREDUMPS / f"{time.strftime('%Y-%m-%d_%H%M%S')}_{dev}.bin"
    path.write_bytes(body)
    print(f"[coredump] {len(body)} bytes from {dev} -> {path.name}")
    return {"ok": True, "bytes": len(body)}


@app.post("/api/device/telemetry")
def api_telemetry(batch: dict, request: Request):
    """One batch per second from a device; the reply carries queued commands and,
    while the Studio records a take on this device, its progress for the screen.
    `nav` is the current nav pack version: the device refetches when it changes."""
    batch.setdefault("ip", request.client.host)
    device = str(batch.get("device", ""))
    # clock: this computer's local wall time, seconds since 1970 as if it were UTC (the device has no RTC or zone)
    t = time.time()
    clock = int(t + time.localtime(t).tm_gmtoff)
    return {"commands": telemetry.ingest(batch), "take": live.take_for(device), "live": stream.wanted(device),
            "nav": _nav_pack(device)["v"], "clock": clock}


@app.get("/api/telemetry")
def api_telemetry_devices():
    return {"devices": telemetry.devices()}


@app.get("/api/telemetry/{device}")
def api_telemetry_recent(device: str, since: int = 0):
    return {"batches": telemetry.recent(device, since)}


@app.get("/api/telemetry/{device}/live")
def api_telemetry_live(device: str):
    """Server-sent events of raw sensor samples at 25 Hz; opening it puts the device in live mode."""
    return StreamingResponse(stream.events(device), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class Command(BaseModel):
    cmd: str
    arg: str | None = None


@app.post("/api/telemetry/{device}/command")
def api_command(device: str, c: Command):
    telemetry.queue_command(device, c.model_dump(exclude_none=True))
    return {"queued": c.cmd}


_dist = Path(__file__).resolve().parent.parent / "studio" / "dist"
if _dist.exists():
    app.mount("/studio", StaticFiles(directory=_dist, html=True), name="studio")
