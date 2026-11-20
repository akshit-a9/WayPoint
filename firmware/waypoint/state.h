#pragma once

// State shared between the UI task (core 1: knob, sensors, screen) and the
// network task (core 0: WiFi, scans, server). Take the lock for anything
// longer than a single word.

#include <Arduino.h>

#define MAX_APS 40
#define MAX_TOP 5

struct Ap {
  char bssid[18];
  char ssid[33];
  int8_t rssi;
  uint8_t channel;
};

struct Fix {
  bool ok = false;
  char location[48] = "";
  char spot[48] = "";
  float confidence = 0;
  int knownAps = 0, totalAps = 0;
  bool hasXy = false;
  float x = 0, y = 0;
  int nTop = 0;
  char topSpot[MAX_TOP][24];
  float topP[MAX_TOP];
  uint32_t at = 0;          // millis() when it arrived
  uint16_t latencyMs = 0;   // POST /predict round trip
  char error[48] = "";
};

// A recording take the Studio is running on this device (shown full screen)
struct Take {
  bool active = false;
  bool done = false;
  char spot[24] = "";
  uint32_t startMs = 0;     // local millis() when the take started
  uint32_t seconds = 0;
  float turnEvery = 0;      // s between 45Â° turns
  int scans = 0;
  uint32_t seenMs = 0;      // last telemetry reply that mentioned it
};

struct Shared {
  // Network (written by the network task)
  bool wifiUp = false;
  bool serverUp = false;
  int8_t wifiRssi = 0;
  uint8_t wifiChannel = 0;
  char ip[16] = "";
  char site[32] = "";
  uint32_t scans = 0;
  uint16_t lastScanMs = 0;
  int nAps = 0;
  Ap aps[MAX_APS];          // last scan, strongest first
  Fix fix;
  Take take;

  // Sensors (written by the UI task)
  bool magOk = false, mpuOk = false, oledOk = false;
  uint8_t magChipId = 0, mpuWhoAmI = 0;
  int16_t mag[3] = {0, 0, 0};   // raw X, Y, Z
  int16_t acc[3] = {0, 0, 0};   // raw X, Y, Z
  uint8_t i2cFound[8];
  int nI2c = 0;
  uint32_t i2cErrors = 0;

  // UI (written by the UI task)
  const char *screen = "";
  int sel = 0;
  float fps = 0;
  uint8_t telemetryLevel = 2;   // 0 off, 1 basic, 2 full

  // Requests from the network task to the UI (Studio commands)
  char toast[22] = "";
  uint32_t toastUntil = 0;
  bool wantI2cScan = false;
  uint32_t liveUntil = 0;   // millis(): stream sensors to the Studio until then (Debug tab open)
  uint32_t clock = 0, clockAt = 0;   // server's local time (s since 1970) at millis() clockAt; 0 = unknown
  uint32_t telemetrySent = 0, telemetryFailed = 0;
  char navCmd[48] = "";      // "nav" from the Studio: destination spot id or "stop"
  char fakeAt[48] = "";      // test: pretend to be at this spot instead of the WiFi fix
  float fakeHdg = NAN;       // test: pretend to face this way (degrees) instead of the compass
  uint32_t screenUntil = 0;  // millis(): send the screen picture with telemetry until then
  int8_t knob[8];            // test: knob turns / clicks from the Studio (KNOB_*), a small queue
  uint8_t nKnob = 0;
  bool knobOff = false;      // test: ignore the real knob
  int8_t wantTheme = -1;     // "theme light|dark" (saved); -1 = no change
  int8_t wantFlip = -1;      // "flip on|off": turn the screen upside down (saved); -1 = no change

  // Smoothed position: steps + WiFi fixes (track.cpp, UI task)
  struct {
    bool ok = false, moving = false;
    float x = 0, y = 0, sigma = 0;   // site frame, metres; sigma: how unsure
    int floor = -1;                  // floor index in the nav pack
    uint32_t steps = 0;
  } track;

  // Navigation (written by the UI task, for telemetry)
  struct {
    char dest[48] = "", at[48] = "", next[48] = "", cue[22] = "";
    float dist = 0, brg = 0, hdg = NAN;
    bool arrived = false;
  } nav;
};

// Knob events the Studio can inject (anything else in the queue is turn steps)
#define KNOB_CLICK 100
#define KNOB_HOLD 101

extern Shared shared;
extern SemaphoreHandle_t sharedLock;

struct Lock {
  Lock() { xSemaphoreTake(sharedLock, portMAX_DELAY); }
  ~Lock() { xSemaphoreGive(sharedLock); }
};
