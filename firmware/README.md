# firmware

The ESP32 sketch (`waypoint/`) and the WiFi flashing script. Setup (board
package, libraries, `secrets.h`) and wiring are in the
[top-level README](../README.md).

## How it runs

Two FreeRTOS tasks share one `Shared` struct (`state.h`) under a mutex:

| Task | Core | Does |
|---|---|---|
| UI (`loop()`) | 1 | Knob, sensors at 50 Hz, step tracking, screen at up to 30 fps. The only code that touches I2C. |
| Network (`net.cpp`) | 0 | Keeps WiFi up, scans channels 1/6/11, `POST /predict`, sends a telemetry batch every second and runs the commands in its reply, fetches the nav pack and WiFi updates. |
| Live (`net.cpp`) | 0 | While the Studio's Device tab is open: raw sensors to the server over UDP (port 8001) at 25 Hz; scans pause. |

A slow WiFi scan never freezes the knob or the screen.

## Files (`waypoint/`)

| File | What it does |
|---|---|
| `waypoint.ino` | `setup()` / `loop()`, crash report, safe mode |
| `config.h` | Pins, timings, `PRODUCTION`, `DISPLAY_TFT`, radio settings, `FW_VERSION` |
| `secrets.h` | WiFi and server address (copy `secrets.example.h`; git-ignored) |
| `state.h` | The struct both tasks share |
| `net.*` | Network task: WiFi, scans, `/predict`, telemetry, commands, nav pack, OTA, crash-dump upload |
| `telemetry.*` | Ring buffers for log lines, UI events and sensor samples, drained into each batch |
| `sensors.*` | QMC5883P magnetometer (0x2C) and MPU-6050 (0x68) on the shared I2C bus |
| `track.*` | Smoothed position: steps from the accelerometer (0.65 m each) pulled towards each WiFi fix by how sure it is |
| `nav.*` | The nav pack (spots, links, floors, compass calibration), compass heading, Dijkstra routing, turn-by-turn maneuvers, steps list, map links |
| `input.*` | Rotary encoder: turn / click / hold |
| `ui.*` | Every screen, built as a `View` each frame |
| `view.h` | `View` (what a screen shows) and the `Display` interface |
| `tft_st7735.*` | The 1.8" ST7735R TFT: dark/light themes, fonts, icons, scrolling text, slide transitions, screen mirror |
| `oled_sh1106.*` | The old 1.3" OLED (`DISPLAY_TFT 0`) |
| `leds.*` | API LED (GPIO2) and the RGB status LED (off on TFT builds: its pins went to the screen) |

### Screens

`ui.cpp` fills a display-independent `View`; `tft_st7735.cpp` draws it into a
128×160 RGB332 canvas and pushes it to the panel only when the picture
changed. The same canvas, run-length coded, is the Studio's screen mirror.

- **Home**: Navigate / Where am I / Tools cards with a live sub-line, clock.
- **Navigate** → destination list (route distance, arrow pointing at each) →
  navigation with three pages, switched by turning the knob:
  1. *Compass*: instruction card ("Turn left / in 6 m"), arrow to the next
     spot (green when you face it), north marker.
  2. *Map*: corridors within 40 m, the route, you at the centre facing up,
     the destination pin or the stairs where the route changes floor.
  3. *Steps*: every turn, floor change and the arrival with its distance.

  Arrival shows a check mark and confetti; click returns home.
- **Where am I**: place, confidence bar, accuracy, steps, APs heard.
- **Tools** → Position, Live scan, Network, Sensors, Display test,
  Settings (Theme, Heading smoothing, Telemetry, Reboot), About.

Heading smoothing is a moving average of the compass over 0 / 0.25 / 0.5 / 1 s
(Off / Low / Medium / High). Theme, heading smoothing, telemetry level and
screen flip are saved on the board (`Preferences`).

## Flashing

**First time:** over USB (see the top-level README). The board must run a
build with the `update` command before WiFi updates work.

**After that, over WiFi**, with the board on its breadboard supply, the API
server running and the board online:

```powershell
.\firmware\flash-wifi.ps1        # from the repo root (Windows PowerShell)
```

It compiles into `firmware/build/`, tells the board to `update`, and waits
until the board reports the new build's MD5. The board downloads
`GET /api/device/firmware` (that `.bin`) and reboots into it.

On macOS/Linux, do the same by hand:

```bash
arduino-cli compile --fqbn esp32:esp32:esp32 --output-dir firmware/build firmware/waypoint
curl -X POST "http://localhost:8000/api/telemetry/<device-id>/command" \
     -H "Content-Type: application/json" -d '{"cmd":"update"}'
```

`<device-id>` is the board's MAC (the Studio's Device tab shows it), URL-encoded
(`A4%3AF0%3A0F%3A5C%3A0C%3AAC`).

The script needs telemetry level Basic or Full on the board; with it Off the
board doesn't report its build and the script times out (the update may still
have worked).

## Commands from the Studio

Sent with `POST /api/telemetry/<device>/command` `{"cmd": ..., "arg": ...}`
and delivered with the board's next telemetry reply (dev builds only). The
Studio's buttons use these.

| cmd | arg | Does |
|---|---|---|
| `update` | | Download and flash the server's build, reboot |
| `reboot` | | Restart |
| `level` | `0` / `1` / `2` | Telemetry Off / Basic / Full (not saved) |
| `screen` | seconds | Send the screen picture with each batch for that long |
| `toast` | text | Show a message pill on the screen |
| `nav` | spot id / `stop` | Start or stop navigating |
| `at`, `hdg` | spot id / degrees, or `off` | Pretend a position or heading (testing without sensors) |
| `knob` | `n` / `click` / `hold` / `on` / `off` | Fake knob input; `off` ignores the real knob |
| `theme` | `dark` / `light` | Colours (saved) |
| `flip` | `on` / `off` | Upside-down screen (saved) |
| `radio` | `sleep on|off`, `tx <2..20>` | WiFi modem sleep and transmit power (not saved) |
| `i2cscan` | | Rescan the I2C bus |

## When it crashes

- The panic handler saves an ELF core dump to flash. On the next boot the
  board logs the crash (task, PC, backtrace) to the Studio's log, uploads
  the dump to `POST /api/device/coredump` (saved in `data/coredumps/`) and
  erases it. Decode it with the crashing build's `.elf`:
  `xtensa-esp32-elf-gdb firmware/build/waypoint.ino.elf <dump>`.
- **Safe mode:** a crash within 20 s of booting makes the next boot start
  only the network (no screen, sensors or knob), so a bad build can always be
  replaced over WiFi. The Studio's log says `SAFE MODE`.

## Notes

- `PRODUCTION 1` hides Tools (hold the knob while booting to get it),
  lowers telemetry to Basic and ignores Studio commands.
- Static DRAM is nearly full: put big buffers on the heap (see the canvas in
  `tft_st7735.cpp` and the mirror buffers in `net.cpp`). A large `malloc` in a
  global constructor stops the ESP32 from starting its main task, so allocate
  in `begin()`.
- Changing `config.h` or `state.h` rebuilds everything (5–10 min); other files
  take a minute or two.
