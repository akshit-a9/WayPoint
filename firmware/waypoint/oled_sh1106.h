#pragma once

#include "view.h"

// 1.3" JMD1.3A OLED: SH1106, 128x64, I2C 0x3C, on the shared sensor bus.
// Drawn as 128x32 because half its rows are dead (see oled_sh1106.cpp).
class OledSh1106 : public Display {
 public:
  bool begin() override;
  void draw(const View &v) override;
  int visibleRows() const override;
  const char *name() const override { return "OLED SH1106 128x32"; }
  size_t snapshot(uint8_t *out, size_t n) override;

 private:
  bool present = false;   // nothing answered at 0x3C: draw into the buffer, skip sending it
};
