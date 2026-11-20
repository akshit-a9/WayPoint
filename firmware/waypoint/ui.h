#pragma once

// The screens, driven only by the knob:
//   turn  move / scroll        click  open / act        hold  back
// Every submenu starts with "< BACK" too, for anyone who doesn't know to hold.
//
//   NAVIGATE            destinations, nearest first, with distance and a direction arrow
//     <destination>     turn-by-turn; turn the knob for compass / map / steps; click or hold stops
//   WHERE AM I          the place, how sure, accuracy, steps
//   TOOLS               dev builds, or hold the knob while booting
//     Position          spot, confidence, top 5, x/y, latency
//     Live scan         every AP in the last scan
//     Network           WiFi, IP, server, site, telemetry counters
//     Sensors           I2C bus, chip IDs, raw magnetometer / accelerometer
//     Display test      patterns to spot dead rows / pixels
//     Settings          theme, heading smoothing, telemetry level (all saved), reboot
//     About

#include "input.h"
#include "view.h"

void uiInit(Display &display, bool toolsUnlocked);
void uiInput(const InputEvent &e);
void uiDraw();   // build the current screen's View and draw it
// Latest screen picture, if new: bytes copied (0 = none). Network task, for the Studio.
struct ScreenInfo { const char *format; int w, h; };
size_t uiScreen(uint8_t *out, size_t n, ScreenInfo *info);
