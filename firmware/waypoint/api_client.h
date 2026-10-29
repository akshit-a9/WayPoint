#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

// What came back from one /predict request.
struct Location {
  bool ok = false;              // true: name/confidence are valid
  bool serverReached = false;   // true: the server answered (even with an error)
  String name;                  // e.g. "D-152"
  float confidence = 0;         // 0..1
  int knownAps = 0;             // scanned APs the model recognises
  int totalAps = 0;             // APs the model knows in total
  String error;                 // set when ok is false
};

// GET /health. True if the server is up.
bool apiIsReachable();

// POST the scan (built by scanWifi) to /predict.
Location apiPredict(const JsonDocument &request);
