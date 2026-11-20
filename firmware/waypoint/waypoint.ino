// WayPoint: shows where you are indoors, using WiFi.
//
// Two tasks:
//   UI task (this loop, core 1)   knob, sensors at 50 Hz, screen at ~30 fps.
//                                 The only code that touches I2C.
//   Network task (core 0)         WiFi scans, POST /predict, and a telemetry
//                                 batch to the laptop every second, so all
//                                 debugging works without a serial cable.
// They share `shared` (state.h) under a mutex.
//
//   config.h          pins, timings, PRODUCTION switch
//   secrets.h         WiFi name/password and server address (copy secrets.example.h)
//   input.*           rotary encoder: turn / click / hold
//   view.h            what a screen shows; Display = the panel interface
//   tft_st7735.*      the 1.8" TFT (DISPLAY_TFT 1, current)
//   oled_sh1106.*     the old OLED (DISPLAY_TFT 0)
//   ui.*              the screens
//   nav.*             navigation: the server's nav pack, compass heading, routing
//   sensors.*         QMC5883P magnetometer, MPU-6050
//   track.*           smoothed position: steps from the accelerometer + WiFi fixes
//   net.*             the network task
//   telemetry.*       log / event / sensor ring buffers sent with each batch
//   leds.*            API LED + RGB status LED

#include <Wire.h>
#include <esp_core_dump.h>
#include <esp_ota_ops.h>

#include "config.h"
#include "input.h"
#include "leds.h"
#include "nav.h"
#include "net.h"
#include "oled_sh1106.h"
#include "sensors.h"
#include "tft_st7735.h"
#include "state.h"
#include "telemetry.h"
#include "track.h"
#include "ui.h"

Shared shared;
SemaphoreHandle_t sharedLock;

#if DISPLAY_TFT
static TftSt7735 screen;
#else
static OledSh1106 screen;
#endif

// The last crash, from the core dump the panic handler saved in flash: logged
// so it reaches the Studio without a serial cable (decode the addresses with
// addr2line against that build's .elf). The network task then sends the whole
// dump to the server and erases it.
static void reportCrash() {
  if (esp_core_dump_image_check() != ESP_OK) return;
  auto *s = (esp_core_dump_summary_t *)malloc(sizeof(esp_core_dump_summary_t));
  if (s && esp_core_dump_get_summary(s) == ESP_OK) {
    tlog("Last crash: task %s PC 0x%08lx cause %lu addr 0x%08lx elf %.8s", s->exc_task, (unsigned long)s->exc_pc,
         (unsigned long)s->ex_info.exc_cause, (unsigned long)s->ex_info.exc_vaddr, (const char *)s->app_elf_sha256);
    char line[96];
    size_t len = 0;
    for (uint32_t i = 0; i < s->exc_bt_info.depth && i < 16; i++) {
      len += snprintf(line + len, sizeof line - len, " %08lx", (unsigned long)s->exc_bt_info.bt[i]);
      if (len > 70 || i + 1 == s->exc_bt_info.depth) { tlog("Backtrace:%s", line); len = 0; }
    }
  }
  free(s);
}

// Safe mode: after a crash in the first SAFE_WINDOW_MS of a boot, the next boot
// runs only the network (telemetry, crash dump upload, WiFi updates): no
// screen, sensors or knob. So a bad build can always be replaced over WiFi.
// The image is marked good at once for that reason: a crash no longer rolls
// back to the previous build, it lands here.
static const uint32_t SAFE_MAGIC = 0x5AFE0001, SAFE_WINDOW_MS = 20000;
RTC_NOINIT_ATTR static uint32_t rtcMagic, rtcUptime;   // survive a crash reset
static bool safeMode = false;

static bool crashedEarly() {
  esp_reset_reason_t r = esp_reset_reason();
  bool crash = r == ESP_RST_PANIC || r == ESP_RST_INT_WDT || r == ESP_RST_TASK_WDT || r == ESP_RST_WDT;
  bool early = rtcMagic == SAFE_MAGIC && rtcUptime < SAFE_WINDOW_MS;
  rtcMagic = SAFE_MAGIC;
  rtcUptime = 0;
  return crash && early;
}

void setup() {
  Serial.begin(115200);
  sharedLock = xSemaphoreCreateMutex();
  telemetryInit();
  safeMode = crashedEarly();
  esp_ota_mark_app_valid_cancel_rollback();
  reportCrash();
  if (safeMode) {
    navInit();   // the network task loads nav packs into it
    tlog("SAFE MODE: crashed %lu ms after the last boot; screen, sensors and knob are off", (unsigned long)SAFE_WINDOW_MS);
    netStart();
    return;
  }
  navInit();
  ledsInit();
  inputInit();
  delay(20);
  bool tools = !PRODUCTION || digitalRead(PIN_ENC_SW) == LOW;   // hold the knob while booting

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, I2C_HZ);
  tlog("Screen: starting");
  bool screenOk = screen.begin();
  tlog("Screen: started");
  { Lock l; shared.oledOk = screenOk; }
  sensorsInit();
  uiInit(screen, tools);
  netStart();
}

void loop() {
  static uint32_t lastSensor = 0, lastSample = 0, lastFrame = 0, fpsSince = 0, frames = 0;
  rtcUptime = millis();
  if (safeMode) { delay(100); return; }

  bool knobOff;
  { Lock l; knobOff = shared.knobOff; }
  for (InputEvent e = inputPoll(); e.type != IN_NONE; e = inputPoll()) if (!knobOff) uiInput(e);

  uint32_t now = millis();
  if (now - lastSensor >= SENSOR_MS) { lastSensor = now; sensorsRead(); trackUpdate(now); }
  if (now - lastSample >= TELEMETRY_SAMPLE_MS) {
    lastSample = now;
    int16_t mag[3], acc[3];
    { Lock l; memcpy(mag, shared.mag, sizeof mag); memcpy(acc, shared.acc, sizeof acc); }
    tsample(mag, acc);
  }

  bool rescan;
  { Lock l; rescan = shared.wantI2cScan; shared.wantI2cScan = false; }
  if (rescan) { sensorsScanBus(); tlog("I2C bus rescanned (Studio)"); }

  if (now - lastFrame >= FRAME_MS) { lastFrame = now; uiDraw(); frames++; }
  if (now - fpsSince >= 1000) {
    Lock l;
    shared.fps = frames * 1000.0f / (now - fpsSince);
    frames = 0;
    fpsSince = now;
  }
  delay(1);
}
