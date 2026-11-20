# WayPoint

A handheld device that finds where you are inside a building using WiFi, and
walks you to a room turn by turn (IoT course project, CS G518).

An ESP32 scans the WiFi around it and sends the scan to a server on a laptop.
The server's model, trained for that building, says which spot you are at.
The device smooths the fix with its step counter, routes over the building's
map and shows the way on a colour screen, steered with one rotary knob. A web
app, the **Studio**, is used to map the building, record WiFi, train models,
watch the device live and send it new firmware over WiFi.

```
 Device (firmware/)                      Laptop
 ──────────────────                      ──────────────────────────────────────
 scan WiFi ─────── POST /predict ──────▶ api-server/   model of the active site
 1.8" TFT, knob ◀── {spot, x/y, top 5}   (FastAPI)     sites/<id>/ packs
 compass, steps                                        │
 telemetry ─────── POST /api/device/... ▶              ├─ serves the Studio at /studio/
 OTA update ◀───── GET /api/device/firmware            │
                                          studio/  ◀───┘  Map · Record · Train · Live · Device
```

Changes on this branch are summarised in [docs/CHANGES.md](docs/CHANGES.md).

## What's where

```
.
├── api-server/        Laptop server: /predict, the Studio's API, telemetry, OTA (README inside)
├── studio/            The Studio web app (React + Vite, README inside)
├── firmware/
│   ├── waypoint/      ESP32 sketch (README in firmware/)
│   └── flash-wifi.ps1 Build and flash over WiFi (Windows; manual steps in firmware/README.md)
├── sites/
│   └── bits-main/     D block: 52 spots, links, destinations, 53 WiFi takes, floor plans
├── data/devices/      Compass calibration per board (made on the Studio's Device tab)
└── docs/              Reports and the change log
```

Git-ignored, so each laptop has its own: `api-server/.venv`, `studio/node_modules`,
`firmware/waypoint/secrets.h`, `firmware/build/`, `private/` (personal sites,
the campus PDF), `data/sessions/` (telemetry logs), `data/coredumps/` and
`sites/active.txt` (which site this laptop localizes).

## Set up a laptop (once)

You need **Python 3.11+**, **Node 20.19+** (22 or newer is fine) and
**arduino-cli** or Arduino IDE 2.

### 1. API server

```bash
cd api-server
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Studio

```bash
cd studio
npm install
npm run build                      # the server then serves it at /studio/
```

### 3. Firmware toolchain

- Board package **esp32 by Espressif 3.3.x** (tested on 3.3.12). In Arduino IDE add
  `https://espressif.github.io/arduino-esp32/package_esp32_index.json` under
  Preferences → Additional boards manager URLs, or:
  `arduino-cli core install esp32:esp32`
- Libraries (Library Manager or `arduino-cli lib install "<name>"`):
  **Adafruit ST7735 and ST7789 Library**, **Adafruit GFX Library** (pulls in
  Adafruit BusIO), **ArduinoJson** 7.x, **U8g2** (only for the old OLED, but
  the sketch includes it).
- Board **ESP32 Dev Module** (FQBN `esp32:esp32:esp32`), default partition
  scheme. It has the two app slots that WiFi updates need.

### 4. Secrets

```bash
cp firmware/waypoint/secrets.example.h firmware/waypoint/secrets.h
```

Fill in a **2.4 GHz** network (a laptop or phone hotspot is easiest) and the
laptop's address on it. With a Windows Mobile Hotspot the laptop is always
`192.168.137.1`.

```c
#define WIFI_SSID     "MyHotspot"
#define WIFI_PASSWORD "..."
#define API_BASE_URL  "http://192.168.137.1:8000"
```

## Run it

1. **Hotspot on**, laptop and device on it.
2. **Start the server** (from `api-server/`, venv active):
   `uvicorn server:app --host 0.0.0.0 --port 8000`.
   Wait for `Model ready`. On Windows, let Python through the firewall for
   private networks the first time.
3. **Open the Studio** at http://localhost:8000/studio/ (or
   `http://<laptop-ip>:8000/studio/` from a phone on the hotspot).
4. **Pick the site** in the header: *BITS main building (D block)*. The site
   you pick is the one the device localizes in (`/predict` answers for it).
5. **Flash the device.** The first time, over USB:

   ```bash
   arduino-cli compile --fqbn esp32:esp32:esp32 firmware/waypoint
   arduino-cli upload  --fqbn esp32:esp32:esp32 -p <port> firmware/waypoint
   ```

   After that, over WiFi with the device on the breadboard supply:
   `.\firmware\flash-wifi.ps1` (see [firmware/README.md](firmware/README.md)).
6. **Calibrate the compass** once per board: Studio → Device → **Calibrate
   compass**, turn the board slowly through every direction until the ring is
   full, then **Done**. It
   is saved in `data/devices/<MAC>.json` and sent to the board with the map.
   The team board's calibration is already committed.

## Day to day

| I want to... | Do this |
|---|---|
| Map spots, destinations, links | **Map** tab. The D block's floor plans are already placed under the satellite view; add spots, mark destinations, connect them (C), link stairs/lifts across floors from a spot's panel, try a route. Edits save on their own; Ctrl+Z undoes. |
| Record WiFi at a spot | **Record** tab: pick the device and the spot, press Start, stand there for 90 s and turn 45° right at each beep (the device screen shows the same cues). The take lands in `sites/<site>/recordings/`. |
| Train a model | **Train** tab: Train, look at the score (whole takes held out, errors in metres), make the best version active. Models go to `sites/<site>/models/vN.joblib`. |
| Watch the device | **Live** tab: predicted spot, smoothed track and trail, top 5, raw scan, and a live mirror of the device's screen. |
| Send the device somewhere | **Live** → Navigate: pick a destination. For a board without sensors, pretend a position/heading there. |
| Debug the device | **Device** tab: health charts, sensor stream, I2C, log, commands (reboot, toast, telemetry level). |
| Change the screen | Under the mirror on **Live**: Dark/Light, Flip, radio sleep/TX power. On the device: Tools → Settings. |

Commit the site's `site.json`, `recordings/` and the models you want to keep,
so the rest of the team gets them.

## Using the device

One knob: **turn** to move, **click** to choose, **hold** (0.6 s) to go back.

- **Navigate**: destinations nearest first, with route distance and an arrow
  pointing at each. Choose one to get turn-by-turn directions. Turn the knob
  to switch between the **compass**, a **map** that turns with you and the
  **list of steps**. The distance left and the ETA stay at the bottom.
- **Where am I**: the place, how sure the model is, accuracy and steps.
- **Tools** (dev builds, or hold the knob while it boots): position details,
  live scan, network, sensors, display test, **Settings** (theme, heading
  smoothing, telemetry), About.

## Wiring (current build)

Everything is on one breadboard powered by an **MB102** supply: its 5 V rail
feeds the ESP32's VIN, its 3.3 V rail feeds every module. USB alone powers
only the ESP32, so plug the supply in for the sensors and screen.

| Part | Pin | ESP32 / rail |
|---|---|---|
| 1.8" TFT (ST7735R, red board) | VCC, LED | 3.3 V |
| | GND | GND |
| | SCK | GPIO27 |
| | SDA (MOSI) | GPIO26 |
| | A0 (DC) | GPIO25 |
| | CS | GPIO33 |
| | RESET | 3.3 V (tied high) |
| EC11 encoder module | 5V | **3.3 V** (never 5 V: its pull-ups would put 5 V on GPIO34/35) |
| | S1 / S2 / Key | GPIO34 / GPIO35 / GPIO32 |
| | GND | GND |
| MPU-6050 (GY-521) and GY-271 (QMC5883P) | VCC / GND | 3.3 V / GND |
| | SDA / SCL | GPIO14 / GPIO13 (shared I2C bus) |
| API LED (optional) | + through 220 Ω–1 kΩ | GPIO2 (also the DevKit's blue LED) |

Pins and options live in `firmware/waypoint/config.h`. `DISPLAY_TFT 0` builds
for the old 1.3" SH1106 OLED on the I2C bus instead.

## Problems

| What you see | What to check |
|---|---|
| Device stuck "joining WiFi" | Wrong SSID/password in `secrets.h`, or the network is 5 GHz only. |
| Red dot in the screen's top bar, Studio shows no device | Server not running, wrong `API_BASE_URL`, not on the same network, or the firewall blocks port 8000. |
| "Not sure" / few known APs | You are outside the mapped area, or the wrong site is picked in the Studio header. |
| Arrow points the wrong way | Calibrate the compass (Device tab). Keep the board flat and away from magnets and laptops. |
| Screen upside down | Live → Flip (saved on the board). |
| Screen flickers or blanks at random | A loose jumper on the TFT's VCC/LED/GND or RESET. Push the header in or move it to fresh breadboard rows. |
| `flash-wifi.ps1` says "No new build" | Telemetry level is Off on the board, so the script can't see the build. Set it to Full in Tools → Settings, or check the Device tab. |
| `secrets.h: No such file or directory` | Do step 4 of the setup. |

The model and data history: the original phone survey and the first model come
from the [Indoor-Localization](https://github.com/akshit-a9/Indoor-Localization)
repo. `api-server/import_legacy.py` turned its recordings into the D block's
takes.
