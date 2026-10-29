#include <WiFi.h>

#include "config.h"
#include "scanner.h"

int scanWifi(JsonDocument &request) {
  // blocking scan, include hidden networks, active scan
  int found = WiFi.scanNetworks(false, true, false, SCAN_MS_PER_CHANNEL);
  if (found < 0) return -1;

  JsonArray scans = request["scans"].to<JsonArray>();
  for (int i = 0; i < found; ++i) {
    JsonObject ap = scans.add<JsonObject>();
    ap["bssid"] = WiFi.BSSIDstr(i);  // the AP's MAC address, e.g. "70:ea:1a:22:a9:41"
    ap["rssi"] = WiFi.RSSI(i);       // signal strength in dBm, e.g. -60
    Serial.printf("  %s  %4d dBm  %s\n", WiFi.BSSIDstr(i).c_str(), WiFi.RSSI(i), WiFi.SSID(i).c_str());
  }
  WiFi.scanDelete();  // free the scan results
  return found;
}
