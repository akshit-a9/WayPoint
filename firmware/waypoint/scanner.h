#pragma once

#include <ArduinoJson.h>

// Scans for nearby WiFi access points and adds each one to request["scans"]
// as {"bssid": "...", "rssi": -60}, the format the server's /predict expects.
// Returns how many were found, or -1 if the scan failed.
int scanWifi(JsonDocument &request);
