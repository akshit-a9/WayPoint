"""HTTP API for the WayPoint device.

Run from this folder:
    uvicorn server:app --host 0.0.0.0 --port 8000
"""

from fastapi import FastAPI
from pydantic import BaseModel

import localizer

app = FastAPI(title="WayPoint API")


class AccessPoint(BaseModel):
    bssid: str
    rssi: float


class ScanRequest(BaseModel):
    scans: list[AccessPoint]


@app.get("/health")
def health():
    """The ESP32 calls this at boot to check the server is up."""
    return {
        "status": "ok",
        "locations": len(localizer.label_map),
        "known_aps": len(localizer.feature_bssids),
    }


@app.get("/locations")
def locations():
    """Every location the model can answer with."""
    return localizer.label_map


@app.post("/predict")
def predict(req: ScanRequest):
    """Takes one WiFi scan, returns the most likely location."""
    result = localizer.predict({ap.bssid: ap.rssi for ap in req.scans})
    print(
        f"scan of {len(req.scans)} APs ({result['known_aps']} known) -> "
        f"{result['location']} ({result['confidence']:.0%})"
    )
    return result
