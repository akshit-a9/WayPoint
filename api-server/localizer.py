"""Turns one WiFi scan into a location using the trained model.

The model file is a dict saved by Indoor-Localization/03_Training/06_Train_2_4GHz_Model.py.
It holds everything we need:
    "model"           the trained RandomForestClassifier
    "feature_bssids"  the 149 access points the model knows, in the order it expects
    "label_map"       class number -> location name
"""

from pathlib import Path

import joblib
import numpy as np

MODEL_PATH = Path(__file__).parent / "model" / "Random_Forest_2_4GHz.joblib"

# Training used -100 dBm for "this access point was not heard".
MISSING_RSSI = -100.0

print(f"Loading {MODEL_PATH.name} ...")
_bundle = joblib.load(MODEL_PATH)
model = _bundle["model"]
model.n_jobs = 1  # one scan at a time: extra threads only add overhead
feature_bssids = [b.lower() for b in _bundle["feature_bssids"]]
label_map = {int(k): v for k, v in _bundle["label_map"].items()}
print(f"Model ready: {len(feature_bssids)} access points, {len(label_map)} locations")


def predict(scan: dict[str, float]) -> dict:
    """scan maps BSSID -> RSSI (dBm), e.g. {"70:ea:1a:22:a9:4e": -55}."""
    heard = {bssid.lower(): rssi for bssid, rssi in scan.items()}

    # One number per known access point, in training order. APs the model has
    # never seen are ignored; known APs that were not heard get MISSING_RSSI.
    features = np.array(
        [[heard.get(bssid, MISSING_RSSI) for bssid in feature_bssids]],
        dtype=np.float32,
    )

    probabilities = model.predict_proba(features)[0]
    best = int(np.argmax(probabilities))
    class_index = int(model.classes_[best])

    return {
        "location": label_map[class_index],
        "confidence": round(float(probabilities[best]), 3),
        "known_aps": sum(1 for bssid in feature_bssids if bssid in heard),
        "total_aps": len(feature_bssids),
    }
