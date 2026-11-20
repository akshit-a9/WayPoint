#pragma once

// Network task, pinned to core 0 so a ~1.7 s WiFi scan never freezes the
// knob or the screen. Over and over:
//   - keep WiFi up
//   - scan, POST /predict, publish the fix to `shared`
//   - once a second, POST a telemetry batch and run any commands it returns
// Plus a small "live" task: while the Studio's Debug tab is open (the
// telemetry reply says "live"), raw sensors go out over UDP at 25 Hz and the
// scans pause.

void netStart();
const char *deviceId();   // WiFi MAC, e.g. "A4:CF:12:34:56:78"
bool isLive();            // the Studio is watching the live sensor stream
