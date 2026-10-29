# api-server

A small web server that runs on your laptop. The WayPoint device sends it a
list of the WiFi networks it can see, and the server replies with where you
are.

It is a cut-down copy of `04_API/` from the
[Indoor-Localization](https://github.com/akshit-a9/Indoor-Localization) repo.
It keeps only the one model the ESP32 can use, so nothing else from that
repo is needed.

## Files

```
api-server/
├── server.py           The web server: defines the URLs (/health, /predict, ...)
├── localizer.py        Loads the model and turns a WiFi scan into a location
├── model/
│   └── Random_Forest_2_4GHz.joblib   The trained model (~74 MB)
├── sample_scan.json    A real scan, for testing without the ESP32
└── requirements.txt    Python packages to install
```

## How it works

1. During data collection a phone recorded which WiFi access points (APs) are
   visible at 52 spots in the building, and how strong each one is (RSSI, in
   dBm, e.g. -55 is strong and -90 is weak).
2. A Random Forest model was trained on that data. It knows 149 APs, each
   identified by its BSSID (the AP's MAC address, like `70:ea:1a:22:a9:41`).
3. When a scan comes in, `localizer.py` builds a list of 149 numbers, one per
   known AP, in the order the model expects. APs that were not heard get
   -100 dBm. APs the model has never seen are ignored.
4. The model scores every location and the server returns the best one,
   along with how sure it is (`confidence`, from 0 to 1).

### Why the 2.4 GHz model

The ESP32 can only hear 2.4 GHz WiFi, but the phone also recorded 5 GHz APs.
The standard model relies on those 5 GHz APs too, and with ESP32 scans its
accuracy falls from 94% to 40%. This model was retrained without the 5 GHz
APs (`03_Training/06_Train_2_4GHz_Model.py` in Indoor-Localization). It scores
91% on the test set.

## Setup (once)

You need Python 3.11 or newer. From the `api-server/` folder:

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
source .venv/bin/activate          # Windows: .venv\Scripts\activate
uvicorn server:app --host 0.0.0.0 --port 8000
```

Wait for `Model ready: 149 access points, 52 locations`. Each scan the
device sends then prints one line:

```
scan of 18 APs (18 known) -> Opp_CSIS_Meeting_Room (87%)
```

`--host 0.0.0.0` lets other devices on the network reach the server. Without
it, only your laptop can.

## Test it without the ESP32

In a second terminal:

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/predict \
     -H "Content-Type: application/json" -d @sample_scan.json
```

Or open http://localhost:8000/docs in a browser and try the endpoints there.

## Connecting the ESP32

The ESP32 and the laptop must be on the **same 2.4 GHz network**. The
simplest setup is a hotspot from the laptop or a phone.

Find the laptop's IP address on that network:

- macOS: `ipconfig getifaddr en0`
- Windows: `ipconfig` and look for "IPv4 Address". With Windows Mobile
  Hotspot the laptop is always `192.168.137.1`.

Put it in the firmware's `secrets.h` as `http://<that-ip>:8000`. On Windows,
allow Python through the firewall for private networks the first time it asks.

## Endpoints

| Method | URL          | What it does                                  |
|--------|--------------|-----------------------------------------------|
| GET    | `/health`    | Says the server is up. The ESP32 calls it at boot. |
| GET    | `/locations` | Lists all 52 locations the model can return.  |
| POST   | `/predict`   | Takes one WiFi scan, returns a location.      |

`POST /predict` request:

```json
{
  "scans": [
    { "bssid": "70:ea:1a:22:a9:41", "rssi": -77 },
    { "bssid": "08:4f:a9:10:4b:81", "rssi": -81 }
  ]
}
```

Response:

```json
{
  "location": "Opp_CSIS_Meeting_Room",
  "confidence": 0.867,
  "known_aps": 18,
  "total_aps": 149
}
```

`known_aps` is how many of the scanned APs the model recognises. If it is 0,
the location is a meaningless guess (the firmware shows an error instead).

## Using a newly trained model

Retrain in Indoor-Localization, copy the new `.joblib` bundle into `model/`,
and update `MODEL_PATH` in `localizer.py` if the file name changed. The bundle
must be a dict with `model`, `feature_bssids` and `label_map`, like the one
`06_Train_2_4GHz_Model.py` saves. Then restart the server.

## Problems

| Symptom | Fix |
|---------|-----|
| Error or warning when loading the model | Install exactly `scikit-learn==1.8.0`. The model file only loads reliably with the version that saved it. |
| Works with `localhost` but the ESP32 can't connect | Start with `--host 0.0.0.0`, check both are on the same network, and allow Python through the firewall. |
| `known_aps` is 0 or very low | You are outside the mapped area, or the scan was sent to the wrong server. |
