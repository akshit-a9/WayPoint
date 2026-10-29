# WayPoint

A handheld device that shows where you are inside the building, using WiFi
(IoT course project, CS G518).

An ESP32 scans the WiFi networks around it and sends the list to a small
server on your laptop. The server's trained model works out the location, and
the ESP32 shows it on its OLED screen.

```
 ESP32                                   Laptop (api-server/)
 ─────                                   ────────────────────
 1. scan WiFi access points
 2. POST /predict  ───── WiFi ─────▶     model picks the closest location
 3. show it on the OLED  ◀────────────   {"location": "D-152", "confidence": 0.84}
```

## Folders

```
.
├── api-server/          The laptop server + trained model (has its own README)
├── firmware/waypoint/   The ESP32 code
├── archive/             The old, more complex firmware (reference only)
└── docs/Reports/        Mid-semester reports
```

The model was trained in the
[Indoor-Localization](https://github.com/akshit-a9/Indoor-Localization) repo.
Everything needed to run it has been copied into `api-server/`.

## The LEDs

**API LED** (single LED): **on** while the server answers, **off** when it
doesn't.

**Status LED** (RGB): shows which step the device is on.

| Colour | Meaning |
|--------|---------|
| Purple | Connecting to WiFi |
| Blue   | Scanning WiFi networks |
| Yellow | Scan sent, waiting for the server |
| Green  | Response received, location is on the screen |
| Red    | Something went wrong (the screen says what) |

## Wiring (ESP32 DevKit)

Use 3V3 for power, never VIN (that is 5 V). Boards like the ESP32-32X label
pins `D21`, `D22` and so on; `D21` means GPIO21.

| Part          | Part pin | ESP32 pin |
|---------------|----------|-----------|
| OLED 1.3" I2C | VCC      | 3V3       |
|               | GND      | GND       |
|               | SCL      | D22       |
|               | SDA      | D21       |
| RGB LED       | R        | D27       |
|               | G        | D26       |
|               | B        | D25       |
|               | common (longest leg) | GND (or 3V3 for a common-anode LED, then set `RGB_COMMON_ANODE 1` in `config.h`) |
| API LED       | + (long leg)  | D2, through a 220 Ω–1 kΩ resistor |
|               | − (short leg) | GND       |

D2 also drives the small blue LED built into most DevKits, so the API LED
works before you wire anything. The firmware sets the LED pins to their
weakest drive (~5 mA), so LEDs without resistors won't be damaged.

Some OLED modules have VCC and GND in the other order, so go by the labels
printed on the board.

## Quick start

### 1. Start the server on your laptop

See [api-server/README.md](api-server/README.md). In short:

```bash
cd api-server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

### 2. Put the laptop and the ESP32 on the same 2.4 GHz network

A hotspot from your phone or laptop is easiest (set it to 2.4 GHz). Note the
laptop's IP address on it (`ipconfig getifaddr en0` on macOS, `ipconfig` on
Windows).

### 3. Flash the ESP32

Copy the secrets template and fill in the WiFi name, password and the
laptop's address:

```bash
cp firmware/waypoint/secrets.example.h firmware/waypoint/secrets.h
```

```c
#define WIFI_SSID     "MyHotspot"
#define WIFI_PASSWORD "password123"
#define API_BASE_URL  "http://192.168.1.5:8000"
```

`secrets.h` is git-ignored, so the password won't be committed.

Then open `firmware/waypoint/waypoint.ino` in Arduino IDE 2 and upload, with:

- Board package **esp32** by Espressif. Add
  `https://espressif.github.io/arduino-esp32/package_esp32_index.json` to
  Preferences → Additional boards manager URLs first.
- Board **ESP32 Dev Module**.
- Libraries **U8g2** and **ArduinoJson** (version 7), from the Library Manager.

Or use the command line:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/waypoint
arduino-cli upload  --fqbn esp32:esp32:esp32 -p <port> firmware/waypoint
```

### 4. Watch it work

Open the Serial Monitor at **115200** baud to see each step: the APs found,
the request being sent, and the location that comes back. The server terminal
prints one line per scan too.

## Firmware files

| File | What it does |
|------|--------------|
| `waypoint.ino`   | `setup()` and `loop()`: connect, then scan → send → show, forever |
| `scanner.*`      | Scans WiFi and builds the JSON request |
| `api_client.*`   | Talks to the server (`/health`, `/predict`) |
| `display.*`      | Draws the OLED screens |
| `leds.*`         | API LED and RGB status LED |
| `config.h`       | Pins and timings |
| `secrets.h`      | WiFi and server address (you create it from `secrets.example.h`) |

## Problems

| What you see | What to check |
|--------------|---------------|
| Stuck on purple / "Connecting WiFi" | Wrong SSID or password, or the network is 5 GHz only. |
| "Server not found", API LED off | Server not running, wrong IP in `secrets.h`, not on the same network, or the laptop firewall is blocking port 8000. |
| Red, "No known WiFi APs here" | You are outside the area the model was trained on. |
| Screen text only on every other line | Our panel needs `OLED_ROW_DOUBLE 1` in `config.h`. Set it to 0 on a healthy screen. |
| Screen shows garbage | It may not be an SH1106. Try `archive/hw_check/`, which tests several driver types. |
| `secrets.h: No such file or directory` | You skipped the copy in step 3. |
