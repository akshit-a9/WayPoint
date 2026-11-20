#pragma once

#include "view.h"

// 1.8" red-board TFT: ST7735R, 128x160, SPI (SCK 27, SDA/MOSI 26, A0/DC 25,
// CS 33, RESET tied to 3.3 V, backlight always on). Portrait, header pins at
// the top. Frames are drawn into an 8-bit RGB332 canvas (20 KB) and pushed
// only when they change; the same canvas, run-length coded, is the Studio's
// screen mirror.
class TftSt7735 : public Display {
 public:
  bool begin() override;
  void draw(const View &v) override;
  int visibleRows() const override;
  const char *name() const override { return "TFT ST7735 128x160"; }
  size_t snapshot(uint8_t *out, size_t n) override;
  const char *snapFormat() const override { return "rle332"; }
  int snapWidth() const override { return 128; }
  int snapHeight() const override { return 160; }
  void setFlip(bool flip) override;
  void setTheme(bool light) override;
};
