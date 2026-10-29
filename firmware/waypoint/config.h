#pragma once

// ---------------------------------------------------------------------------
// Pins (GPIO numbers; boards like the ESP32-32X print GPIO21 as "D21")
// ---------------------------------------------------------------------------
#define PIN_OLED_SDA 21
#define PIN_OLED_SCL 22

// API LED: a single LED that is ON while the server is reachable.
// GPIO2 is also the small blue LED built into most ESP32 DevKits, so this
// works even before an external LED is wired.
#define PIN_API_LED 2

// Status LED: RGB LED showing what the device is doing right now.
#define PIN_RGB_R 27
#define PIN_RGB_G 26
#define PIN_RGB_B 25

// 0 = common cathode (long leg to GND), 1 = common anode (long leg to 3V3)
#define RGB_COMMON_ANODE 0

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------
// Our panel only lights every other pixel row. 1 copies each row onto the one
// below so text stays readable. Set to 0 on a healthy display.
#define OLED_ROW_DOUBLE 1

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------
#define SCAN_INTERVAL_MS     2000  // pause between one result and the next scan
#define SCAN_MS_PER_CHANNEL  120   // how long the scan listens on each WiFi channel
#define HTTP_TIMEOUT_MS      8000  // give up on the server after this long

#define SERIAL_BAUD 115200
