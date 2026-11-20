#include "config.h"

#if !DISPLAY_TFT   // the old OLED; the TFT replaced it

#include "oled_sh1106.h"

#include <U8g2lib.h>
#include <Wire.h>

// The bus is started in setup() (Wire.begin on PIN_I2C_SDA/SCL); U8g2 uses it as is.
static U8G2_SH1106_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE);

// Our panel's odd pixel rows are dead. With the COM pins set to sequential
// (0xDA 0x02) the top 32 rows of the buffer land on the 32 working rows,
// spread over the full height. So everything is laid out on a 128x32 canvas;
// each pixel shows twice as tall as it is wide.
static const int W = 128, H = 32, HEAD_H = 8, ROW_H = 8, LIST_Y = HEAD_H;

bool OledSh1106::begin() {
  Wire.beginTransmission(0x3C);
  bool ok = Wire.endTransmission() == 0;
  present = ok;
  oled.begin();
  oled.setBusClock(I2C_HZ);
  oled.sendF("ca", 0xDA, 0x02);       // COM pins: sequential (see above)
  oled.setFont(u8g2_font_5x7_tf);   // 5x7, like the bench's GLCD font
  oled.setFontPosTop();
  return ok;
}

int OledSh1106::visibleRows() const { return (H - LIST_Y) / ROW_H; }

static void header(const char *title, const char *corner) {
  oled.setDrawColor(1);
  oled.drawBox(0, 0, W, HEAD_H);
  oled.setDrawColor(0);
  oled.drawStr(2, 1, title);
  if (corner[0]) oled.drawStr(W - 2 - oled.getStrWidth(corner), 1, corner);
  oled.setDrawColor(1);
}

// Menus (selectable) and info/message screens (scroll by first visible row)
static void list(const View &v, bool selectable, int vis) {
  int top = selectable ? max(0, min(v.sel - vis / 2, v.nRows - vis)) : max(0, min(v.sel, v.nRows - vis));
  bool bar = v.nRows > vis;
  int right = bar ? W - 4 : W;
  for (int i = top; i < min(v.nRows, top + vis); i++) {
    int y = LIST_Y + (i - top) * ROW_H;
    bool on = selectable && i == v.sel;
    if (on) { oled.drawBox(0, y, right - 1, ROW_H); oled.setDrawColor(0); }
    oled.drawStr(2, y + 1, v.rows[i].label);
    if (v.rows[i].value[0]) oled.drawStr(right - 3 - oled.getStrWidth(v.rows[i].value), y + 1, v.rows[i].value);
    oled.setDrawColor(1);
  }
  if (bar) {   // scrollbar: thin track, solid thumb
    int th = H - LIST_Y, tb = max(4, th * vis / v.nRows);
    int scrollable = selectable ? v.nRows - 1 : v.nRows - vis;
    int pos = selectable ? v.sel : top;
    oled.drawVLine(W - 1, LIST_Y, th);
    oled.drawBox(W - 3, LIST_Y + (th - tb) * pos / max(1, scrollable), 3, tb);
  }
}

static void pattern(int p) {
  if (p == 0) oled.drawBox(0, 0, W, H);   // all on: dead pixels show
  else if (p == 1) for (int y = 0; y < H; y++) for (int x = (y & 1); x < W; x += 2) oled.drawPixel(x, y);
  else if (p == 2) { oled.drawFrame(0, 0, W, H); oled.drawLine(0, 0, W - 1, H - 1); oled.drawLine(0, H - 1, W - 1, 0); }
  else for (int x = 0; x < W; x += 8) oled.drawBox(x, 0, 4, H);
}

// Recording screen:  header (state, spot, scans) | countdown + progress bar | cue
static void take(const View &v) {
  char title[sizeof v.title + sizeof v.rows[0].label];
  snprintf(title, sizeof title, "%s %s", v.title, v.rows[0].label);
  header(title, v.corner);

  oled.setFont(u8g2_font_7x13B_tf);
  oled.drawStr(1, 9, v.big);
  int bx = 2 + oled.getStrWidth(v.big) + 4;
  oled.setFont(u8g2_font_5x7_tf);
  int bw = (v.arrow ? W - 16 : W) - bx;
  oled.drawFrame(bx, 11, bw, 9);
  oled.drawBox(bx + 2, 13, (int)((bw - 4) * constrain(v.progress, 0.0f, 1.0f)), 5);
  if (v.arrow) {   // turn right: shaft and head pointing right
    oled.drawBox(W - 13, 14, 7, 3);
    oled.drawTriangle(W - 6, 10, W - 6, 20, W - 1, 15);
  }

  if (v.cueAlert) { oled.drawBox(0, H - ROW_H, W, ROW_H); oled.setDrawColor(0); }
  oled.drawStr((W - oled.getStrWidth(v.cue)) / 2, H - ROW_H + 1, v.cue);
  oled.setDrawColor(1);
}

// Navigation: compass dial on the left, destination, distance and an info
// line on the right (after the bench layout in esp32-display-bench.html).
// Angles are in real pixels; canvas rows are half as many, so every y is
// halved: circles become 2:1 ellipses on the canvas and round on the glass.
static const float DIAL_X = 31, DIAL_Y = 15, DIAL_R = 30;

static void dialPoint(float deg, float r, int &x, int &y) {
  float a = deg * PI / 180;
  x = lroundf(DIAL_X + r * sinf(a));
  y = lroundf(DIAL_Y - r * cosf(a) / 2);
}

static void nav(const View &v) {
  oled.drawEllipse(DIAL_X, DIAL_Y, DIAL_R, DIAL_R / 2);
  oled.drawEllipse(DIAL_X, DIAL_Y, DIAL_R - 1, DIAL_R / 2 - 1);
  int x, y;
  for (int t = 30; t < 360; t += 30) {
    if (t % 90 == 0) continue;
    dialPoint(v.north + t, DIAL_R - 5, x, y);
    oled.drawBox(x, y, 2, 1);
  }
  static const char *const CARD[] = {"N", "E", "S", "W"};
  for (int k = 0; k < 4; k++) {
    dialPoint(v.north + k * 90, DIAL_R - 10, x, y);
    if (k == 0) {   // north stands out: inverted
      oled.drawBox(x - 3, y - 4, 7, 9);
      oled.setDrawColor(0);
    }
    oled.drawStr(x - 2, y - 3, CARD[k]);
    oled.setDrawColor(1);
  }
  if (v.here) {
    oled.setFont(u8g2_font_6x10_tf);
    oled.drawStr(DIAL_X - 11, DIAL_Y - 4, "HERE");
    oled.setFont(u8g2_font_5x7_tf);
  } else if (!isnan(v.needle)) {
    // Arrow outline from the bench, in units of 0.6 R, cut into triangles (it is concave)
    static const float P[7][2] = {{0, -.8f}, {.42f, .22f}, {.13f, .1f}, {.13f, .6f}, {-.13f, .6f}, {-.13f, .1f}, {-.42f, .22f}};
    static const uint8_t T[5][3] = {{0, 1, 2}, {0, 2, 5}, {0, 5, 6}, {2, 3, 4}, {2, 4, 5}};
    float a = v.needle * PI / 180, c = cosf(a), s = sinf(a), k = DIAL_R * 0.6f;
    int px[7], py[7];
    for (int i = 0; i < 7; i++) {
      px[i] = lroundf(DIAL_X + k * (P[i][0] * c - P[i][1] * s));
      py[i] = lroundf(DIAL_Y + k * (P[i][0] * s + P[i][1] * c) / 2);
    }
    for (auto &t : T) oled.drawTriangle(px[t[0]], py[t[0]], px[t[1]], py[t[1]], px[t[2]], py[t[2]]);
    oled.setDrawColor(0);
    oled.drawBox(DIAL_X, DIAL_Y, 2, 1);   // hub
    oled.setDrawColor(1);
  }

  const int X = 66;
  char name[13];
  strlcpy(name, v.title, sizeof name);
  oled.drawStr(X, 0, name);
  oled.setFont(u8g2_font_7x13B_tf);
  oled.drawStr(X, 8, v.big);
  oled.setFont(u8g2_font_5x7_tf);
  if (v.cueAlert) { oled.drawBox(X - 1, 23, W - X + 1, ROW_H); oled.setDrawColor(0); }
  oled.drawStr(X, 24, v.cue);
  oled.setDrawColor(1);
}

size_t OledSh1106::snapshot(uint8_t *out, size_t n) {
  // Pages 0..3 hold the 32 canvas rows: 4 x 128 bytes, LSB = top row of each page
  size_t len = min(n, (size_t)(W * H / 8));
  memcpy(out, oled.getBufferPtr(), len);
  return len;
}

void OledSh1106::draw(const View &v) {
  oled.clearBuffer();
  oled.setDrawColor(1);
  if (v.kind == VIEW_PATTERN) {
    pattern(v.pattern);
  } else if (v.kind == VIEW_TAKE) {
    take(v);
  } else if (v.kind == VIEW_NAV) {
    nav(v);
  } else {
    header(v.title, v.corner);
    list(v, v.kind == VIEW_MENU || v.kind == VIEW_HOME, visibleRows());
  }
  if (v.toast[0]) {   // over the bottom row, inverted
    oled.setDrawColor(1); oled.drawBox(0, H - ROW_H, W, ROW_H);
    oled.setDrawColor(0); oled.drawStr((W - oled.getStrWidth(v.toast)) / 2, H - ROW_H + 1, v.toast);
    oled.setDrawColor(1);
  }
  if (v.hold > 0) {   // hold bar along the bottom
    oled.setDrawColor(0); oled.drawBox(0, H - 3, W, 3);
    oled.setDrawColor(1); oled.drawBox(0, H - 2, (int)(W * v.hold), 2);
  }
  if (present) oled.sendBuffer();   // a bare board still draws, for the Studio's mirror
}

#endif
