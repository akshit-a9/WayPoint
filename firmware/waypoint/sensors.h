#pragma once

// The I2C sensors on the shared bus. Only the UI task touches I2C, so the
// OLED and the sensors never fight over the bus.
//   QMC5883P magnetometer (GY-271) at 0x2C. It lies flat on the breadboard
//            (Z up), so heading comes from X and Y (calibration: F3).
//   MPU-6050 (GY-521) at 0x68: stands upright, X up; accelerometer for tilt
//            and, later, steps.

#include <Arduino.h>

void sensorsInit();          // probes the bus and configures what it finds
void sensorsScanBus();       // refreshes shared.i2cFound (Sensors screen)
void sensorsRead();          // one 50 Hz sample into shared.mag / shared.acc
