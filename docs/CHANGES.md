# Changes on this branch

`main` had the first version: the ESP32 scanned WiFi, sent it to the laptop,
and printed the one location that came back on the OLED, using the model
copied from Indoor-Localization. This branch turns that into a device you can
navigate with, plus the tools to map, record and train for any building.

## Device (firmware/)

- **Two tasks:** the UI (knob, sensors, screen) on one core, the network
  (WiFi, scans, server) on the other, so a 0.6–1.7 s scan never freezes the
  screen. The old `scanner`, `api_client` and `display` modules are replaced
  by `net`, `ui`, `view` and the display drivers.
- **Hardware:** 1.8" ST7735R colour TFT (was the 1.3" OLED, still supported
  with `DISPLAY_TFT 0`), EC11 rotary encoder as the only input, QMC5883P
  magnetometer and MPU-6050 on one I2C bus.
- **Navigation on the device:** it downloads the site's spots, links, floors
  and its own compass calibration (the nav pack), routes with Dijkstra and
  gives turn-by-turn directions ("Bear right in 12 m", "Stairs up"), with
  three pages: compass, a map that turns with you, and the list of steps.
  Distance left, ETA, progress, and an arrival screen.
- **Position:** WiFi fixes smoothed with a step counter from the
  accelerometer, so the dot moves as you walk instead of jumping.
- **Compass:** heading from the calibrated magnetometer, with a moving-average
  smoothing setting (Off / 0.25 / 0.5 / 1 s).
- **Screens:** home cards, destination list with distance and arrows, Where
  am I, Tools (position, live scan, network, sensors, display test, settings,
  about). Dark and light themes, slide transitions, scrolling for long names,
  a clock from the server, upside-down mounting.
- **No serial cable needed:** telemetry once a second (health, scans, fixes,
  UI events, sensor samples, log lines), commands from the Studio, a live
  copy of the screen, and firmware updates over WiFi (`flash-wifi.ps1`).
- **Crash handling:** core dumps are uploaded to the server; a crash early in
  boot starts a network-only safe mode, so a bad build can be replaced over
  WiFi.
- **Radio:** WiFi modem sleep off and transmit power 11 dBm by default, which
  is gentler on the shared breadboard supply. Both can be changed from the
  Studio. The TFT's SPI clock is at the datasheet limit (15 MHz).

## Server (api-server/)

- **Site packs** (`sites/<id>/`): any building can be mapped, recorded and
  trained; `/predict` answers for the active site, so the firmware never
  changes between buildings.
- **Recording** takes from the device, **training** a Random Forest per site
  with honest (held-out-take) scores in metres, versioned models.
- **Device support:** telemetry storage and logs, commands, the 25 Hz UDP
  sensor stream, the nav pack, the firmware download, crash dumps,
  per-device compass calibration, the clock.

## Studio (studio/, new)

A web app served by the server at `/studio/`: Map (draw spots, destinations,
links, stairs and lifts over the floor plan and satellite view), Record,
Train, Live (watch and navigate the device, mirror of its screen) and Device
(health, sensors, compass calibration, log, commands).

## Data

- `sites/bits-main/`: the D block. 52 spots across two floors, placed on the
  floor plans, with links and destinations. 53 WiFi takes (the original phone
  survey imported with `import_legacy.py`, plus ESP32 takes). The floor plans
  are in `plans/`.
- `data/devices/`: the team board's compass calibration.
