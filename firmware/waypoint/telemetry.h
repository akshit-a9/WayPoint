#pragma once

// Everything worth knowing while debugging, collected from both tasks and
// sent to the laptop once a second (no serial cable needed). Each call just
// appends to a ring buffer; the network task drains them into one POST.

#include <Arduino.h>

void telemetryInit();

// printf-style log line (also printed on Serial, in case a cable is attached)
void tlog(const char *fmt, ...);

// UI event, e.g. tevent("click", sel) or tevent("screen", 0, "TOOLS")
void tevent(const char *type, int value = 0, const char *text = nullptr);

// One 10 Hz sensor sample (raw magnetometer + accelerometer)
void tsample(const int16_t mag[3], const int16_t acc[3]);

// Called by the network task: fills `out` with everything queued since the
// last call. Returns false if there was nothing to send.
#include <ArduinoJson.h>
void telemetryDrain(JsonDocument &out);
