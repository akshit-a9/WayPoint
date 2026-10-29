// WayPoint: shows where you are indoors, using WiFi.
//
// Over and over:
//   1. scan the WiFi access points around us        (RGB LED blue)
//   2. send the scan to api-server on the laptop     (RGB LED yellow)
//   3. show the location it sends back on the OLED   (RGB LED green, red on error)
// The API LED stays on while the server is answering.
//
// Each step lives in its own file:
//   leds.*        API LED + RGB status LED
//   display.*     OLED screens
//   scanner.*     WiFi scan -> request body
//   api_client.*  talking to api-server
//   config.h      pins and timings
//   secrets.h     WiFi name/password and server address (copy secrets.example.h)

#include <WiFi.h>
#include <ArduinoJson.h>

#include "config.h"
#include "secrets.h"
#include "leds.h"
#include "display.h"
#include "scanner.h"
#include "api_client.h"

static void connectWifi() {
  statusLedSet(STATUS_CONNECTING_WIFI);
  apiLedSet(false);
  displayMessage("Connecting WiFi", WIFI_SSID);
  Serial.printf("Connecting to %s", WIFI_SSID);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    Serial.print(".");
    delay(500);
  }

  Serial.printf("\nWiFi connected, IP %s\n", WiFi.localIP().toString().c_str());
  displayMessage("WiFi connected", WiFi.localIP().toString());
  delay(1000);
}

static void checkServer() {
  Serial.printf("Checking server at %s ... ", API_BASE_URL);
  bool ok = apiIsReachable();
  Serial.println(ok ? "ok" : "NOT reachable");
  apiLedSet(ok);
  displayMessage(ok ? "Server found" : "Server not found", API_BASE_URL);
  delay(1500);
}

static void showError(const String &error) {
  Serial.printf("Error: %s\n", error.c_str());
  statusLedSet(STATUS_ERROR);
  displayMessage("Error", error);
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  Serial.println("\nWayPoint starting");

  ledsInit();
  displayInit();
  displayMessage("WayPoint", "Starting...");

  WiFi.mode(WIFI_STA);  // station mode: join a network, don't create one
  connectWifi();
  checkServer();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
    return;
  }

  // 1. Scan
  statusLedSet(STATUS_SCANNING);
  Serial.println("Scanning...");
  JsonDocument request;
  int found = scanWifi(request);
  if (found <= 0) {
    showError(found < 0 ? "WiFi scan failed" : "No WiFi networks found");
    delay(SCAN_INTERVAL_MS);
    return;
  }

  // 2. Send it to the server
  statusLedSet(STATUS_SCAN_SENT);
  Serial.printf("Sending %d APs to the server...\n", found);
  Location location = apiPredict(request);
  apiLedSet(location.serverReached);

  // 3. Show the answer
  if (location.ok) {
    statusLedSet(STATUS_RESPONSE_RECEIVED);
    Serial.printf("Location: %s (%.0f%%, %d/%d known APs)\n", location.name.c_str(),
                  location.confidence * 100, location.knownAps, location.totalAps);
    displayLocation(location.name, location.confidence, location.knownAps, location.totalAps);
  } else {
    showError(location.error);
  }

  delay(SCAN_INTERVAL_MS);
}
