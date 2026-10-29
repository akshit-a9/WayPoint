#pragma once

// What the RGB status LED is showing.
enum Status {
  STATUS_OFF,                // off
  STATUS_CONNECTING_WIFI,    // purple
  STATUS_SCANNING,           // blue
  STATUS_SCAN_SENT,          // yellow: waiting for the server
  STATUS_RESPONSE_RECEIVED,  // green
  STATUS_ERROR,              // red
};

void ledsInit();
void apiLedSet(bool serverReachable);
void statusLedSet(Status status);
