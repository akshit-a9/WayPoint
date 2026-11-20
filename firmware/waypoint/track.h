#pragma once

// Where the device is, smoothed: WiFi fixes jump between neighbouring spots, so
// the position moves with your steps and leans towards each fix only as much as
// the fix deserves.
//
// Steps come from the accelerometer, held in the palm: the bounce of each step
// shows in the size of the acceleration (so it works however the board is
// tilted). Each step moves the position one stride along the compass heading.
// Each WiFi fix pulls it closer, weighted by the fix's confidence and by how
// sure the track already is (a Kalman filter on x and y). Fixes far off are
// ignored until a few in a row agree, then the track jumps there.
//
// Runs in the UI task next to the 50 Hz sensor reads; writes shared.track.

#include <Arduino.h>

void trackUpdate(uint32_t now);
