#pragma once

// Copy this file to secrets.h (git-ignored, so passwords stay off GitHub)
// and fill it in.

// Must be a 2.4 GHz network: the ESP32 cannot join 5 GHz networks.
#define WIFI_SSID     "your-2.4GHz-network"
#define WIFI_PASSWORD "your-password"

// The laptop running api-server/, on the same network as the ESP32.
// See api-server/README.md, "Connecting the ESP32", for how to find the IP.
#define API_BASE_URL  "http://192.168.137.1:8000"
