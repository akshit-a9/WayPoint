#pragma once

#define FW_VERSION "0.6.0-dev"

// Development builds show TOOLS in the menu, send full telemetry and accept
// commands from the Studio. Set to 1 for a production build (TOOLS is still
// reachable by holding the knob while the device boots).
#define PRODUCTION 0

// ---------------------------------------------------------------------------
// Pins (GPIO numbers; boards like the ESP32-32X print GPIO14 as "D14")
// ---------------------------------------------------------------------------
// One I2C bus for the MPU-6050 (0x68) and GY-271 (0x2C) (and the old OLED, 0x3C).
// 14/13 sit on the EN…VIN header, the only side reachable on one breadboard.
#define PIN_I2C_SDA 14
#define PIN_I2C_SCL 13
#define I2C_HZ      400000

// Round EC11 encoder module (S1 S2 Key; the old KY-040 used the same pins).
// 34/35 are input-only with no internal pull-ups; the module's own pull-ups
// (to its "5V" pin, which must get 3.3 V) do the job.
#define PIN_ENC_CLK 34   // S1
#define PIN_ENC_DT  35   // S2
#define PIN_ENC_SW  32   // Key, INPUT_PULLUP
#define ENC_REVERSE 0    // set to 1 if clockwise scrolls up

// Display: 1 = 1.8" ST7735R TFT on SPI (current), 0 = the old 1.3" I2C OLED
#define DISPLAY_TFT 1
#define PIN_TFT_SCK  27
#define PIN_TFT_MOSI 26   // "SDA" on the TFT's header
#define PIN_TFT_DC   25   // "A0"
#define PIN_TFT_CS   33
#define TFT_TAB      INITR_BLACKTAB   // ST7735R init variant; try INITR_GREENTAB if the edges show garbage
#define TFT_SPI_HZ   15000000   // ST7735R datasheet: write clock cycle >= 66 ns (~15 MHz); the ESP32 lands on 13.3 MHz
#define TFT_FLIP     0    // 1 = upside down (also settable from the Studio: "flip on|off")

// API LED: on while the server is reachable. GPIO2 is also the blue LED on
// the DevKit, so it works with nothing wired.
#define PIN_API_LED 2

// RGB status LED: its pins went to the TFT, so it's off (-1). On a board
// without the TFT, 27/26/25 drive it.
#if DISPLAY_TFT
#define PIN_RGB_R -1
#define PIN_RGB_G -1
#define PIN_RGB_B -1
#else
#define PIN_RGB_R 27
#define PIN_RGB_G 26
#define PIN_RGB_B 25
#endif
#define RGB_COMMON_ANODE 0   // 0 = common cathode, 1 = common anode

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
#define HOLD_MS     600   // press this long = "hold" (back / cancel)
#define DEBOUNCE_MS 25

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------
#define FRAME_MS 33        // ~30 fps cap

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
#define SCAN_INTERVAL_MS     100   // pause between one result and the next scan
#define SCAN_MS_PER_CHANNEL  120   // how long the scan listens on each WiFi channel
// Channels to scan. Every AP heard in D block is on 1, 6 or 11, and three
// channels take ~0.6 s against ~2.7 s for all 13. Leave empty ({}) to scan all.
#define SCAN_CHANNELS        {1, 6, 11}
#define HTTP_TIMEOUT_MS      4000
// WiFi radio current (the board and TFT share one supply; spikes flicker the backlight)
#define WIFI_SLEEP           0     // modem sleep: 1 = default ESP32 (bursty), 0 = steady
#define WIFI_TX_DBM          11    // transmit power, 2..20 dBm (ESP32 default ~20)

// Step tracking (track.cpp), device held in the palm
#define STEP_HIGH_G          0.12f // bounce over gravity that counts as a step's peak
#define STEP_MIN_MS          300   // steps closer than this are one step
#define STEP_MAX_GAP_MS      1500  // a peak with none this close before it waits for the next
#define STRIDE_M             0.65f // metres per step
#define TRACK_FIX_SIGMA_M    1.5f  // how far off a fully confident WiFi fix may be
#define SENSOR_MS            20    // 50 Hz magnetometer / accelerometer
#define TELEMETRY_SAMPLE_MS  100   // 10 Hz sensor samples in telemetry
#define TELEMETRY_MS         1000  // one batch per second
// Live mode (the Studio's Debug tab is open): raw sensors go to the server
// over UDP at 25 Hz and WiFi scans pause (unless a take is recording), so the
// orientation view follows the device with ~0.1 s delay instead of seconds.
#define LIVE_UDP_PORT        8001
#define LIVE_MS              40
#define LIVE_HOLD_MS         4000  // stay live this long after the last "live" reply
