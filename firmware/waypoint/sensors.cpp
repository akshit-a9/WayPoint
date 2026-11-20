#include "sensors.h"

#include <Wire.h>

#include "state.h"
#include "telemetry.h"

#define QMC_ADDR 0x2C
#define MPU_ADDR 0x68

static bool writeReg(uint8_t addr, uint8_t reg, uint8_t val) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

static bool readRegs(uint8_t addr, uint8_t reg, uint8_t *buf, uint8_t n) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(addr, n) != n) return false;
  for (uint8_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

// QMC5883P (datasheet + QST app note): chip ID 0x80 in reg 0x00; data X/Y/Z
// as little-endian int16 in 0x01..0x06. Init sequence from the app note:
//   0x29 = 0x06  axis sign definition
//   0x0B = 0x08  set/reset on, range ±8 G
//   0x0A = 0xCD  normal mode, ODR 200 Hz, oversampling
static bool qmcInit() {
  uint8_t id = 0;
  bool ok = readRegs(QMC_ADDR, 0x00, &id, 1);
  { Lock l; shared.magChipId = id; }
  if (!ok) return false;
  ok = writeReg(QMC_ADDR, 0x29, 0x06) && writeReg(QMC_ADDR, 0x0B, 0x08) && writeReg(QMC_ADDR, 0x0A, 0xCD);
  tlog("QMC5883P chip id 0x%02X, init %s", id, ok ? "ok" : "FAILED");
  return ok;
}

// MPU-6050: WHO_AM_I (0x75) reads 0x68; wake it from sleep (PWR_MGMT_1 = 0)
static bool mpuInit() {
  uint8_t who = 0;
  bool ok = readRegs(MPU_ADDR, 0x75, &who, 1);
  { Lock l; shared.mpuWhoAmI = who; }
  if (!ok) return false;
  ok = writeReg(MPU_ADDR, 0x6B, 0x00) && writeReg(MPU_ADDR, 0x1C, 0x00);   // wake, ±2 g
  tlog("MPU-6050 WHO_AM_I 0x%02X, init %s", who, ok ? "ok" : "FAILED");
  return ok;
}

void sensorsScanBus() {
  uint8_t found[8];
  int n = 0;
  for (uint8_t a = 0x08; a < 0x78 && n < 8; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) found[n++] = a;
  }
  Lock l;
  memcpy(shared.i2cFound, found, n);
  shared.nI2c = n;
}

void sensorsInit() {
  sensorsScanBus();
  bool mag = qmcInit(), mpu = mpuInit();
  Lock l;
  shared.magOk = mag;
  shared.mpuOk = mpu;
  char list[40] = "";
  for (int i = 0; i < shared.nI2c; i++) snprintf(list + strlen(list), sizeof list - strlen(list), " 0x%02X", shared.i2cFound[i]);
  tlog("I2C bus:%s", shared.nI2c ? list : " nothing found");
}

void sensorsRead() {
  uint8_t b[6];
  int16_t mag[3], acc[3];
  bool magOk = shared.magOk && readRegs(QMC_ADDR, 0x01, b, 6);
  if (magOk) for (int k = 0; k < 3; k++) mag[k] = (int16_t)(b[2 * k] | (b[2 * k + 1] << 8));
  bool accOk = shared.mpuOk && readRegs(MPU_ADDR, 0x3B, b, 6);   // big-endian
  if (accOk) for (int k = 0; k < 3; k++) acc[k] = (int16_t)((b[2 * k] << 8) | b[2 * k + 1]);

  Lock l;
  if (magOk) memcpy(shared.mag, mag, sizeof mag);
  if (accOk) memcpy(shared.acc, acc, sizeof acc);
  if ((shared.magOk && !magOk) || (shared.mpuOk && !accOk)) shared.i2cErrors++;
}
