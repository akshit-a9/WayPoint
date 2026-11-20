#include "config.h"

#if DISPLAY_TFT

#include "tft_st7735.h"
#include "telemetry.h"

#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <SPI.h>

static Adafruit_ST7735 tft(&SPI, PIN_TFT_CS, PIN_TFT_DC, -1);   // RESET is tied high: software reset
// RGB332, one byte a pixel. Made in begin(): a 20 KB malloc in a global constructor
// runs before startup has handed all of RAM to the heap, and the ESP32 then fails
// to start its main task (assert in esp_startup_start_app).
static GFXcanvas8 *cv = nullptr;
static uint16_t lut[256];   // RGB332 -> RGB565
static uint32_t shown = 0;  // hash of the frame on the glass

static const int W = 128, H = 160, BAR_H = 18, ROW_H = 15, LIST_Y = 21;

// ---------------------------------------------------------------- colours
// RGB332: 8 levels of red and green, 4 of blue
static constexpr uint8_t C(int r, int g, int b) { return (r & 0xE0) | ((g >> 3) & 0x1C) | (b >> 6); }

struct Theme {
  uint8_t bg, panel, text, dim, faint, accent, onAccent, head, onHead, good, warn, bad;
};
static const Theme DARK = {C(0, 0, 0),       C(36, 36, 85),    C(255, 255, 255), C(146, 146, 170),
                           C(73, 73, 85),    C(0, 219, 255),   C(0, 0, 0),       C(0, 73, 85),
                           C(255, 255, 255), C(36, 219, 85),   C(255, 182, 0),   C(255, 36, 0)};
static const Theme LIGHT = {C(255, 255, 255), C(219, 219, 255), C(0, 0, 85),      C(109, 109, 170),
                            C(182, 182, 170), C(0, 109, 255),   C(255, 255, 255), C(0, 73, 170),
                            C(255, 255, 255), C(0, 146, 0),     C(219, 109, 0),   C(219, 0, 0)};
static const Theme *T = &DARK;

// ---------------------------------------------------------------- text
// F_SMALL is the classic 6x8 font, F_SB the same drawn twice a pixel apart
// (bold, 7 px a character): both fixed width, so long text can scroll a
// character at a time. F_BOLD / F_BIG are FreeSans Bold for the few big
// things (distance, place name). y is always the top of the capitals.
enum Font { F_SMALL, F_SB, F_BOLD, F_BIG };
static const int8_t CAP[] = {0, 0, 13, 17};
static const int8_t ADV[] = {6, 7, 0, 0};   // fixed advance, 0 = proportional

static bool mono(Font f) { return ADV[f] > 0; }

static void useFont(Font f) {
  static const GFXfont *const FONTS[] = {nullptr, nullptr, &FreeSansBold9pt7b, &FreeSansBold12pt7b};
  cv->setFont(FONTS[f]);
  cv->setTextSize(1);
}

static int textW(const char *s, Font f) {
  if (mono(f)) return strlen(s) * ADV[f];
  useFont(f);
  int16_t x1, y1;
  uint16_t w, h;
  cv->getTextBounds(s, 0, 0, &x1, &y1, &w, &h);
  return x1 + w;
}

static void text(int x, int y, const char *s, uint8_t col, Font f = F_SMALL) {
  useFont(f);
  if (f == F_SB) {
    for (; *s; s++, x += ADV[f]) {
      uint8_t c = (uint8_t)*s == 0xB0 ? 0xF8 : *s;
      cv->drawChar(x, y, c, col, col, 1);
      cv->drawChar(x + 1, y, c, col, col, 1);
    }
    return;
  }
  cv->setTextColor(col);
  cv->setCursor(x, y + CAP[f]);
  for (; *s; s++) {
    uint8_t c = *s;
    if (c == 0xB0) c = f == F_SMALL ? 0xF8 : 'o';   // degrees: CP437 in the small font
    cv->write(c);
  }
}
static void textC(int cx, int y, const char *s, uint8_t col, Font f = F_SMALL) { text(cx - textW(s, f) / 2, y, s, col, f); }
static void textR(int right, int y, const char *s, uint8_t col, Font f = F_SMALL) { text(right - textW(s, f), y, s, col, f); }

// s cut to fit maxW pixels, ".." at the end if it didn't
static const char *fit(const char *s, int maxW, Font f) {
  static char buf[40];
  strlcpy(buf, s, sizeof buf);
  if (textW(buf, f) <= maxW) return buf;
  for (int n = strlen(buf); n > 0; n--) {
    buf[n] = 0;
    char t[44];
    snprintf(t, sizeof t, "%s..", buf);
    if (textW(t, f) <= maxW) { strlcpy(buf, t, sizeof buf); return buf; }
  }
  return "";
}

// A window of s that fits maxW: still at the start, slides a character every
// 220 ms to the end, rests there, starts again. Fixed-width fonts only.
static const char *scrolled(const char *s, int maxW, Font f) {
  static char buf[48];
  int n = strlen(s), fitN = maxW / ADV[f];
  if (n <= fitN || fitN <= 0) return s;
  const uint32_t STEP = 220, REST = 1300;
  int extra = n - fitN;
  uint32_t t = millis() % (2 * REST + extra * STEP);
  int off = t < REST ? 0 : t < REST + extra * STEP ? (t - REST) / STEP : extra;
  strlcpy(buf, s + off, min((size_t)fitN + 1, sizeof buf));
  return buf;
}

// Text in a box maxW wide: scrolls if it doesn't fit (or is cut with ".." when scroll is off)
static void textIn(int x, int y, const char *s, int maxW, uint8_t col, Font f = F_SMALL, bool scroll = true) {
  text(x, y, scroll && mono(f) ? scrolled(s, maxW, f) : fit(s, maxW, f), col, f);
}
static void textInC(int cx, int y, const char *s, int maxW, uint8_t col, Font f = F_SMALL) {
  const char *t = mono(f) ? scrolled(s, maxW, f) : fit(s, maxW, f);
  text(cx - textW(t, f) / 2, y, t, col, f);
}

// ---------------------------------------------------------------- shapes
static void dirOf(float deg, float &dx, float &dy) {
  float a = deg * PI / 180;
  dx = sinf(a);
  dy = -cosf(a);
}

static void thickLine(int x0, int y0, int x1, int y1, int w, uint8_t col) {
  bool steep = abs(y1 - y0) > abs(x1 - x0);
  for (int o = -w / 2; o <= (w - 1) / 2; o++) {
    if (steep) cv->drawLine(x0 + o, y0, x1 + o, y1, col);
    else cv->drawLine(x0, y0 + o, x1, y1 + o, col);
  }
  cv->fillCircle(x1, y1, w / 2, col);   // round joints
}

// Polyline of n points (xy pairs), w px thick
static void path(const int8_t *p, int n, int x, int y, int w, uint8_t col) {
  for (int i = 0; i + 1 < n; i++) thickLine(x + p[2 * i], y + p[2 * i + 1], x + p[2 * i + 2], y + p[2 * i + 3], w, col);
}

// Filled arrowhead with its tip at (tx, ty), pointing `deg` clockwise from up
static void arrowHead(float tx, float ty, float deg, float len, float half, uint8_t col) {
  float dx, dy;
  dirOf(deg, dx, dy);
  float bx = tx - dx * len, by = ty - dy * len;
  cv->fillTriangle(lroundf(tx), lroundf(ty), lroundf(bx - dy * half), lroundf(by + dx * half), lroundf(bx + dy * half),
                   lroundf(by - dx * half), col);
}

static void wifiBars(int x, int y, int bars, uint8_t on, uint8_t off) {
  for (int i = 0; i < 4; i++) {
    int h = 3 + 2 * i;
    cv->fillRect(x + i * 4, y + 9 - h, 3, h, i < bars ? on : off);
  }
  if (bars < 0) { cv->drawLine(x, y, x + 6, y + 6, T->bad); cv->drawLine(x + 6, y, x, y + 6, T->bad); }
}

// ---------------------------------------------------------------- icons
static void icon(uint8_t which, int x, int y, uint8_t col, uint8_t bg) {
  switch (which) {
    case ICON_NAV:   // compass
      cv->drawCircle(x, y, 10, col);
      cv->drawCircle(x, y, 9, col);
      cv->fillTriangle(x - 4, y, x + 4, y, x, y - 7, col);
      cv->drawTriangle(x - 4, y, x + 4, y, x, y + 7, col);
      break;
    case ICON_PIN:
      cv->fillCircle(x, y - 3, 7, col);
      cv->fillTriangle(x - 6, y, x + 6, y, x, y + 10, col);
      cv->fillCircle(x, y - 3, 3, bg);
      break;
    case ICON_TOOLS:   // gear
      for (int k = 0; k < 8; k++) {
        float dx, dy;
        dirOf(k * 45, dx, dy);
        cv->fillCircle(x + lroundf(dx * 8), y + lroundf(dy * 8), 2, col);
      }
      cv->fillCircle(x, y, 7, col);
      cv->fillCircle(x, y, 3, bg);
      break;
    case ICON_BACK:
      thickLine(x + 2, y - 4, x - 2, y, 2, col);
      thickLine(x - 2, y, x + 2, y + 4, 2, col);
      break;
  }
}

// Turn-by-turn sign, about 26 px, centred on (x, y)
static void maneuverIcon(uint8_t m, int x, int y, uint8_t col) {
  switch (m) {
    case MAN_STRAIGHT: {
      static const int8_t p[] = {0, 12, 0, -3};
      path(p, 2, x, y, 5, col);
      arrowHead(x, y - 12, 0, 10, 8, col);
      break;
    }
    case MAN_LEFT:
    case MAN_RIGHT: {
      int s = m == MAN_LEFT ? 1 : -1;
      int8_t p[] = {(int8_t)(5 * s), 12, (int8_t)(5 * s), -3, (int8_t)(-3 * s), -3};
      path(p, 3, x, y, 5, col);
      arrowHead(x - 12 * s, y - 3, m == MAN_LEFT ? 270 : 90, 10, 8, col);
      break;
    }
    case MAN_SLIGHT_LEFT:
    case MAN_SLIGHT_RIGHT: {
      int s = m == MAN_SLIGHT_LEFT ? 1 : -1;
      int8_t p[] = {(int8_t)(3 * s), 12, (int8_t)(3 * s), 2, (int8_t)(-3 * s), -4};
      path(p, 3, x, y, 5, col);
      arrowHead(x - 10 * s, y - 11, m == MAN_SLIGHT_LEFT ? 315 : 45, 10, 8, col);
      break;
    }
    case MAN_UTURN: {
      static const int8_t p[] = {6, 12, 6, -4, 3, -9, -3, -9, -6, -4, -6, 1};
      path(p, 6, x, y, 5, col);
      arrowHead(x - 6, y + 11, 180, 10, 8, col);
      break;
    }
    case MAN_UP:
    case MAN_DOWN: {
      static const int8_t p[] = {-12, 11, -6, 11, -6, 5, 0, 5, 0, -1, 6, -1, 6, -7, 12, -7};
      path(p, 8, x, y, 3, col);
      if (m == MAN_UP) arrowHead(x - 6, y - 12, 0, 7, 6, col);
      else arrowHead(x - 6, y - 2, 180, 7, 6, col);
      break;
    }
    case MAN_ARRIVE:
      cv->fillRect(x - 8, y - 12, 3, 25, col);
      cv->fillTriangle(x - 5, y - 12, x - 5, y + 1, x + 11, y - 6, col);
      break;
    case MAN_LOCATING: {
      uint32_t t = millis() / 90;
      for (int k = 0; k < 8; k++) {
        float dx, dy;
        dirOf(k * 45, dx, dy);
        int r = (int)((t + k) % 8) < 3 ? 3 : 2;
        cv->fillCircle(x + lroundf(dx * 9), y + lroundf(dy * 9), r, (int)((t + k) % 8) < 3 ? col : T->faint);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------- pieces
// Title bar: title, then the corner text, server dot and WiFi bars on the right
static void bar(const View &v, const char *title) {
  cv->fillRect(0, 0, W, BAR_H, T->head);
  int x = W - 18;
  wifiBars(x, 4, v.bars, T->onHead, T->faint);
  x -= 7;
  cv->fillCircle(x, 9, 2, v.server ? T->good : T->bad);
  x -= 6;
  if (v.corner[0]) { x -= textW(v.corner, F_SMALL); text(x, 5, v.corner, T->onHead); x -= 4; }
  textIn(5, 5, title, x - 8, T->onHead, F_SB);
}

// Smoothly gliding highlight: eases toward the target row, snaps on a new screen
static float glide(float target, const char *screen) {
  static float y = -1;
  static char last[22] = "";
  if (strcmp(last, screen) || y < 0) { strlcpy(last, screen, sizeof last); y = target; }
  y += (target - y) * 0.5f;
  if (fabsf(target - y) < 0.6f) y = target;
  return y;
}

static void scrollbar(int top, int vis, int n) {
  if (n <= vis) return;
  int th = H - LIST_Y - 2, tb = max(10, th * vis / n);
  cv->fillRoundRect(W - 3, LIST_Y + (th - tb) * top / max(1, n - vis), 3, tb, 1, T->faint);
}

// Menus (selectable) and info screens (scroll by first visible row)
static void list(const View &v, bool selectable) {
  bar(v, v.title);
  int vis = (H - LIST_Y) / ROW_H;
  int top = selectable ? max(0, min(v.sel - vis / 2, v.nRows - vis)) : max(0, min(v.sel, v.nRows - vis));
  int right = W - 6;
  if (selectable && v.nRows) {
    float y = glide(LIST_Y + (v.sel - top) * ROW_H, v.title);
    cv->fillRoundRect(2, lroundf(y), W - 7, ROW_H - 1, 4, T->accent);
  }
  for (int i = top; i < min(v.nRows, top + vis); i++) {
    int y = LIST_Y + (i - top) * ROW_H;
    bool on = selectable && i == v.sel;
    const ViewRow &r = v.rows[i];
    uint8_t fg = on ? T->onAccent : T->text, sub = on ? T->onAccent : T->dim;
    int x = 7;
    if (r.icon == ICON_BACK) { icon(ICON_BACK, 10, y + 7, fg, T->bg); x = 17; }
    int vw = 0;
    if (r.dir != VIEW_NO_DIR) {
      float dx, dy;
      dirOf(r.dir, dx, dy);
      arrowHead(right - 5 + dx * 5, y + 7 + dy * 5, r.dir, 9, 4, on ? T->onAccent : T->accent);
      vw = 13;
    }
    if (r.value[0]) {
      textR(right - vw, y + 4, r.value, selectable ? sub : T->text);
      vw += textW(r.value, F_SMALL) + 5;
    }
    textIn(x, y + 4, r.label, right - vw - x, selectable ? fg : (r.value[0] ? T->dim : T->text), F_SMALL, on || !selectable);
    if (!selectable && i + 1 < min(v.nRows, top + vis)) cv->drawFastHLine(6, y + ROW_H - 1, W - 14, T->panel);
  }
  scrollbar(top, vis, v.nRows);
}

// Main menu: big cards with an icon and a live sub-line
static void home(const View &v) {
  bar(v, "WayPoint");
  const int Y0 = 25, CH = 40, GAP = 5;   // 3 cards fill the screen
  for (int i = 0; i < v.nRows; i++) cv->fillRoundRect(4, Y0 + i * (CH + GAP), W - 8, CH, 7, T->panel);
  float y = glide(Y0 + v.sel * (CH + GAP), "home");
  cv->fillRoundRect(4, lroundf(y), W - 8, CH, 7, T->accent);
  for (int i = 0; i < v.nRows; i++) {
    int cy = Y0 + i * (CH + GAP);
    bool on = i == v.sel && fabsf(y - cy) < CH / 2;
    uint8_t fg = on ? T->onAccent : T->text;
    icon(v.rows[i].icon, 22, cy + CH / 2, on ? T->onAccent : T->accent, on ? T->accent : T->panel);
    textIn(40, cy + 10, v.rows[i].label, W - 46, fg, F_SB, on);
    textIn(40, cy + 23, v.rows[i].value, W - 46, on ? T->onAccent : T->dim, F_SMALL, on);
  }
}

static void splash(const View &v) {
  float p = constrain(v.progress, 0.0f, 1.0f);
  // The pin drops in and bounces, its shadow grows under it
  float t = min(1.0f, p / 0.55f);
  float b = t < 0.6f ? t / 0.6f : 1 - 0.18f * sinf((t - 0.6f) / 0.4f * PI);   // fall, then one bounce
  int py = lroundf(-20 + (62 + 20) * b);
  int sw = lroundf(6 + 10 * b);
  cv->fillRoundRect(64 - sw, 78, 2 * sw, 4, 2, T->panel);
  cv->fillCircle(64, py - 6, 14, T->accent);
  cv->fillTriangle(64 - 12, py, 64 + 12, py, 64, py + 18, T->accent);
  cv->fillCircle(64, py - 6, 6, T->bg);
  if (p > 0.45f) {
    textC(64, 94, "WayPoint", T->text, F_BIG);
    textC(64, 120, "find your way indoors", T->dim);
  }
  if (p > 0.6f) {   // ripple from the pin
    int r = lroundf((p - 0.6f) / 0.4f * 60);
    cv->drawCircle(64, 80, r, T->faint);
  }
  textC(64, H - 12, v.cue, T->faint);
}

// Where am I: a pin, the place in big letters, how sure, details
static void where(const View &v) {
  bar(v, v.title);
  cv->fillCircle(64, 34, 9, T->accent);
  cv->fillTriangle(56, 38, 72, 38, 64, 50, T->accent);
  cv->fillCircle(64, 34, 4, T->bg);
  if (textW(v.big, F_BOLD) <= W - 8) textC(64, 58, v.big, T->text, F_BOLD);
  else textInC(64, 61, v.big, W - 8, T->text, F_SB);
  textInC(64, 79, v.cue, W - 8, T->dim);
  int y = 92;
  if (v.progress > 0) {
    char pct[6];
    snprintf(pct, sizeof pct, "%d%%", (int)(v.progress * 100 + 0.5f));
    text(6, y, "Confidence", T->dim);
    textR(W - 6, y, pct, T->text);
    uint8_t c = v.progress >= 0.7f ? T->good : v.progress >= 0.4f ? T->warn : T->bad;
    cv->fillRoundRect(6, y + 11, W - 12, 6, 3, T->panel);
    cv->fillRoundRect(6, y + 11, max(6, (int)((W - 12) * v.progress)), 6, 3, c);
    y += 24;
  }
  for (int i = 0; i < v.nRows && y < H - 10; i++, y += 12) {
    text(6, y, v.rows[i].label, T->dim);
    textR(W - 6, y, v.rows[i].value, T->text);
  }
}

// Recording screen: ring countdown, turn cue
static void take(const View &v) {
  char title[sizeof v.title + sizeof v.rows[0].label];
  snprintf(title, sizeof title, "%s %s", v.title, v.rows[0].label);
  bar(v, title);
  const int X = 64, Y = 70, R = 34;
  for (int r = R - 3; r <= R; r++) cv->drawCircle(X, Y, r, T->panel);
  float p = constrain(v.progress, 0.0f, 1.0f);
  for (float a = 0; a <= p * 360; a += 3) {
    float dx, dy;
    dirOf(a, dx, dy);
    cv->fillCircle(X + lroundf(dx * (R - 1.5f)), Y + lroundf(dy * (R - 1.5f)), 2, strcmp(v.title, "SAVED") ? T->accent : T->good);
  }
  Font f = textW(v.big, F_BIG) <= 2 * R - 10 ? F_BIG : F_BOLD;
  textC(X, Y - CAP[f] / 2, v.big, T->text, f);
  if (v.arrow) maneuverIcon(MAN_RIGHT, X, 122, T->warn);
  if (v.cueAlert) cv->fillRoundRect(4, H - 22, W - 8, 18, 5, T->warn);
  textInC(X, H - 17, v.cue, W - 12, v.cueAlert ? C(0, 0, 0) : T->text);
}

// The big compass arrow (concave, so cut into triangles)
static void compassArrow(int cx, int cy, float deg, float k, uint8_t col) {
  static const float P[7][2] = {{0, -.8f}, {.42f, .22f}, {.13f, .1f}, {.13f, .6f}, {-.13f, .6f}, {-.13f, .1f}, {-.42f, .22f}};
  static const uint8_t TRI[5][3] = {{0, 1, 2}, {0, 2, 5}, {0, 5, 6}, {2, 3, 4}, {2, 4, 5}};
  float a = deg * PI / 180, c = cosf(a), s = sinf(a);
  int px[7], py[7];
  for (int i = 0; i < 7; i++) {
    px[i] = lroundf(cx + k * (P[i][0] * c - P[i][1] * s));
    py[i] = lroundf(cy + k * (P[i][0] * s + P[i][1] * c));
  }
  for (auto &t : TRI) cv->fillTriangle(px[t[0]], py[t[0]], px[t[1]], py[t[1]], px[t[2]], py[t[2]], col);
}

static void arrived(const View &v) {
  uint32_t t = millis() - v.since;
  // Confetti
  static const uint8_t *const COLS[] = {&DARK.accent, &DARK.warn, &DARK.good, &DARK.bad};
  for (int i = 0; i < 18; i++) {
    int x = (i * 37 + 11) % W + lroundf(4 * sinf(t / 300.0f + i));
    int y = (int)((t / (9 + i % 5)) + i * 29) % (H + 10) - 10;
    cv->fillRect(x, y, 3 + i % 2, 3, *COLS[i % 4]);
  }
  // Rings pulsing out of the badge
  for (int k = 0; k < 2; k++) {
    int r = 30 + (int)((t / 25 + k * 20) % 40);
    if (r < 64) cv->drawCircle(64, 62, r, T->good);
  }
  float pop = min(1.0f, t / 250.0f);
  int R = lroundf(28 * (pop < 1 ? pop * 1.15f : 1));
  cv->fillCircle(64, 62, R, T->good);
  if (pop >= 1) {
    thickLine(51, 63, 60, 72, 5, C(255, 255, 255));
    thickLine(60, 72, 78, 52, 5, C(255, 255, 255));
  }
  textC(64, 104, "You're here!", T->text, F_BOLD);
  textInC(64, 126, v.title, W - 8, T->dim);
}

// Small signs for the steps list, centred on (x, y), about 12 px
static void miniSign(const ViewRow &r, int x, int y, uint8_t col) {
  if (r.dir != VIEW_NO_DIR) {   // turn: a stem up, then the arrow bends the way to go
    thickLine(x, y + 6, x, y, 2, col);
    float dx, dy;
    dirOf(r.dir, dx, dy);
    thickLine(x, y, lroundf(x + dx * 3), lroundf(y + dy * 3), 2, col);
    arrowHead(x + dx * 8, y + dy * 8, r.dir, 6, 4, col);
  } else if (r.icon == ICON_UP || r.icon == ICON_DOWN) {   // stairs
    static const int8_t p[] = {-6, 5, -3, 5, -3, 2, 0, 2, 0, -1, 3, -1, 3, -4, 6, -4};
    path(p, 8, x, y, 1, col);
    if (r.icon == ICON_UP) arrowHead(x - 3, y - 6, 0, 4, 3, col);
    else arrowHead(x - 3, y - 1, 180, 4, 3, col);
  } else if (r.icon == ICON_FLAG) {
    cv->fillRect(x - 4, y - 6, 2, 13, col);
    cv->fillTriangle(x - 2, y - 6, x - 2, y + 1, x + 6, y - 3, col);
  }
}

static void compassPage(const View &v) {
  // Turn-by-turn card
  bool floor = v.man == MAN_UP || v.man == MAN_DOWN;
  uint8_t card = floor ? T->warn : T->panel, ink = floor ? C(0, 0, 0) : T->text;
  cv->fillRoundRect(3, 25, W - 6, 38, 7, card);
  maneuverIcon(v.man, 21, 44, floor ? C(0, 0, 0) : T->accent);
  textIn(40, 32, v.instr, W - 44, ink, F_SB);
  textIn(40, 46, v.instrSub, W - 44, floor ? C(0, 0, 0) : T->accent);

  // Compass: the dial turns with the device, the arrow points along the route
  const int X = 64, Y = 103, R = 32;
  cv->drawCircle(X, Y, R, T->faint);
  cv->drawCircle(X, Y, R - 1, T->faint);
  for (int d = 0; d < 360; d += 30) {
    float dx, dy;
    dirOf(v.north + d, dx, dy);
    int r0 = d % 90 ? R - 4 : R - 6;
    cv->drawLine(X + lroundf(dx * r0), Y + lroundf(dy * r0), X + lroundf(dx * (R - 2)), Y + lroundf(dy * (R - 2)), T->faint);
  }
  {
    float dx, dy;
    dirOf(v.north, dx, dy);
    arrowHead(X + dx * (R + 1), Y + dy * (R + 1), v.north, 7, 4, T->bad);   // north marker on the rim
  }
  if (isnan(v.needle)) maneuverIcon(MAN_LOCATING, X, Y, T->accent);
  else {
    compassArrow(X, Y, v.needle, R * 0.9f, v.aligned ? T->good : T->accent);
    cv->fillCircle(X, Y, 2, T->bg);
  }
}

// Map: corridors nearby, the route, you in the middle facing up
static void mapPage(const View &v) {
  const int TOP = 22, BOT = H - 20;
  if (!v.nRoute) { maneuverIcon(MAN_LOCATING, 64, (TOP + BOT) / 2, T->accent); return; }
  // Fit the route (and you) in the box
  float x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  for (int i = 0; i < v.nRoute; i++) {
    float x = v.route[i][0] / 10.0f, y = v.route[i][1] / 10.0f;
    x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y);
  }
  float s = min((W - 28) / max(x1 - x0, 1.0f), (BOT - TOP - 36) / max(y1 - y0, 1.0f));
  s = constrain(s, 1.5f, 12.0f);   // px per metre
  float cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  int my = (TOP + 14 + BOT) / 2;   // below the instruction strip
  auto X = [&](int16_t d) { return (int)constrain(lroundf(64 + (d / 10.0f - cx) * s), -500L, 600L); };
  auto Y = [&](int16_t d) { return (int)constrain(lroundf(my - (d / 10.0f - cy) * s), -500L, 600L); };
  for (int i = 0; i < v.nLinks; i++) thickLine(X(v.links[i][0]), Y(v.links[i][1]), X(v.links[i][2]), Y(v.links[i][3]), 6, T->panel);
  for (int i = 0; i + 1 < v.nRoute; i++)
    thickLine(X(v.route[i][0]), Y(v.route[i][1]), X(v.route[i + 1][0]), Y(v.route[i + 1][1]), 3, T->accent);
  // The end of what's shown: the destination, or the stairs
  int ex = X(v.route[v.nRoute - 1][0]), ey = Y(v.route[v.nRoute - 1][1]);
  if (v.routeEnd == MAN_ARRIVE) icon(ICON_PIN, ex, ey - 8, T->good, T->bg);
  else if (v.routeEnd == MAN_UP || v.routeEnd == MAN_DOWN) {
    cv->fillCircle(ex, ey, 7, T->warn);
    arrowHead(ex, v.routeEnd == MAN_UP ? ey - 5 : ey + 5, v.routeEnd == MAN_UP ? 0 : 180, 9, 4, C(0, 0, 0));
  }
  // You
  int hx = X(0), hy = Y(0);
  cv->fillCircle(hx, hy, 7, T->bg);
  if (v.heading) arrowHead(hx, hy - 7, 0, 13, 6, T->text);
  else { cv->fillCircle(hx, hy, 4, T->text); cv->drawCircle(hx, hy, 6, T->text); }
  // North, top right
  {
    float dx, dy;
    dirOf(v.north, dx, dy);
    int nx = W - 10, ny = TOP + 24;
    cv->fillCircle(nx, ny, 7, T->bg);
    cv->drawCircle(nx, ny, 7, T->faint);
    arrowHead(nx + dx * 6, ny + dy * 6, v.north, 9, 3, T->bad);
  }
  // What to do next, along the top
  cv->fillRect(0, TOP, W, 13, T->bg);
  char line[40];
  snprintf(line, sizeof line, "%s %s", v.instr, v.instrSub);
  bool floor = v.man == MAN_UP || v.man == MAN_DOWN;
  textIn(4, TOP + 3, line, W - 8, floor ? T->warn : T->accent, F_SB);
}

// Steps: every maneuver left, the next one highlighted
static void stepsPage(const View &v) {
  const int Y0 = 24, RH = 16;
  if (!v.nRows) { textC(64, 70, v.instr[0] ? v.instr : "No route", T->dim); return; }
  int fit = (H - 20 - Y0) / RH;
  for (int i = 0; i < min(v.nRows, fit); i++) {
    int y = Y0 + i * RH;
    const ViewRow &r = v.rows[i];
    if (i == 0) cv->fillRoundRect(2, y, W - 4, RH - 1, 4, T->panel);
    if (i + 1 == fit && v.nRows > fit) {   // no room: say how many more
      char more[12];
      snprintf(more, sizeof more, "+%d more", v.nRows - i);
      textC(64, y + 4, more, T->dim);
      break;
    }
    miniSign(r, 12, y + 7, i == 0 ? T->accent : T->dim);
    int vw = textW(r.value, F_SMALL);
    textR(W - 5, y + 4, r.value, i == 0 ? T->text : T->dim);
    textIn(24, y + 4, r.label, W - 33 - vw, T->text, i == 0 ? F_SB : F_SMALL);
  }
}

// Navigation: progress, a page (compass / map / steps), distance left and ETA
static void nav(const View &v) {
  if (v.here) { arrived(v); return; }
  switch (v.sel) {
    case PAGE_MAP: mapPage(v); break;
    case PAGE_STEPS: stepsPage(v); break;
    default: compassPage(v); break;
  }
  bar(v, v.title);
  cv->fillRect(0, BAR_H, W, 3, T->panel);
  cv->fillRect(0, BAR_H, (int)(W * constrain(v.progress, 0.0f, 1.0f)), 3, T->good);

  // Distance left and ETA, and which page this is
  cv->fillRect(0, H - 20, W, 20, T->bg);
  text(4, H - 18, v.big, T->text, F_BOLD);
  textR(W - 4, H - 19, v.eta, T->dim);
  if (v.cue[0]) textR(W - 4, H - 9, v.cue, T->faint);
  for (int i = 0; i < PAGE_COUNT; i++)
    cv->fillCircle(64 + (i - 1) * 7, H - 4, i == v.sel ? 2 : 1, i == v.sel ? T->text : T->faint);
}

static void pattern(int p) {
  if (p == 0) cv->fillScreen(C(255, 255, 255));   // all white: dead pixels show
  else if (p == 1) {                               // colour bars
    static const uint8_t bars[8] = {C(255, 255, 255), C(255, 255, 0), C(0, 255, 255), C(0, 255, 0),
                                    C(255, 0, 255),   C(255, 0, 0),   C(0, 0, 255),   C(0, 0, 0)};
    for (int i = 0; i < 8; i++) cv->fillRect(0, i * H / 8, W, H / 8 + 1, bars[i]);
    textC(W / 2, 4, "R G B order", C(0, 0, 0));
  } else if (p == 2) {   // geometry: edges and corners must all show
    cv->drawRect(0, 0, W, H, C(255, 255, 255));
    cv->drawLine(0, 0, W - 1, H - 1, C(0, 219, 255));
    cv->drawLine(0, H - 1, W - 1, 0, C(0, 219, 255));
    cv->drawCircle(W / 2, H / 2, 50, C(255, 182, 0));
    textC(W / 2, 6, "TOP", C(255, 255, 255));
  } else {
    cv->fillScreen(C(0, 0, 0));
    for (int y = 0; y < H; y += 8) for (int x = (y / 8 % 2) * 8; x < W; x += 16) cv->fillRect(x, y, 8, 8, C(255, 255, 255));
  }
}

// ---------------------------------------------------------------- Display
bool TftSt7735::begin() {
  cv = new GFXcanvas8(W, H);
  if (!cv->getBuffer()) { tlog("Screen: no RAM for the %dx%d canvas", W, H); delete cv; cv = nullptr; return false; }
  SPI.begin(PIN_TFT_SCK, -1, PIN_TFT_MOSI, PIN_TFT_CS);   // before initR, which would start SPI on the default pins
  tft.initR(TFT_TAB);
  tft.setSPISpeed(TFT_SPI_HZ);
  tft.setRotation(TFT_FLIP ? 2 : 0);
  tft.fillScreen(ST77XX_BLACK);
  cv->cp437(true);
  cv->setTextWrap(false);
  for (int c = 0; c < 256; c++) {
    int r = (c >> 5) & 7, g = (c >> 2) & 7, b = c & 3;
    lut[c] = ((r * 31 / 7) << 11) | ((g * 63 / 7) << 5) | (b * 31 / 3);
  }
  return true;   // write-only bus (no MISO): nothing to ask the panel
}

void TftSt7735::setFlip(bool flip) {
  tft.setRotation(flip ? 2 : 0);
  shown = 0;   // push the next frame even if it didn't change
}

void TftSt7735::setTheme(bool light) {
  T = light ? &LIGHT : &DARK;
  shown = 0;
}

int TftSt7735::visibleRows() const { return (H - LIST_Y) / ROW_H; }

size_t TftSt7735::snapshot(uint8_t *out, size_t n) {
  // [count, colour] pairs, rows top to bottom; 0 if it doesn't fit
  if (!cv) return 0;
  const uint8_t *p = cv->getBuffer();
  size_t len = 0;
  for (int i = 0; i < W * H;) {
    uint8_t c = p[i];
    int run = 1;
    while (i + run < W * H && p[i + run] == c && run < 255) run++;
    if (len + 2 > n) return 0;
    out[len++] = run;
    out[len++] = c;
    i += run;
  }
  return len;
}

void TftSt7735::draw(const View &v) {
  if (!cv) return;
  cv->fillScreen(T->bg);
  switch (v.kind) {
    case VIEW_PATTERN: pattern(v.pattern); break;
    case VIEW_TAKE: take(v); break;
    case VIEW_NAV: nav(v); break;
    case VIEW_HOME: home(v); break;
    case VIEW_WHERE: where(v); break;
    case VIEW_SPLASH: splash(v); break;
    default: list(v, v.kind == VIEW_MENU); break;
  }
  if (v.toast[0]) {   // pill over the bottom
    int w = min(W - 8, textW(v.toast, F_SMALL) + 16);
    cv->fillRoundRect((W - w) / 2, H - 24, w, 18, 9, T->text);
    textInC(W / 2, H - 19, v.toast, w - 10, T->bg);
  }
  if (v.hold > 0) {   // hold-to-go-back bar along the bottom
    cv->fillRect(0, H - 3, W, 3, T->panel);
    cv->fillRect(0, H - 3, (int)(W * v.hold), 3, T->warn);
  }

  // Push only a changed frame (FNV-1a over the canvas, ~0.2 ms)
  const uint8_t *p = cv->getBuffer();
  uint32_t h = 2166136261u;
  for (int i = 0; i < W * H; i++) h = (h ^ p[i]) * 16777619u;
  if (h == shown) return;
  shown = h;
  static uint16_t row[W];
  if (v.slide) {
    // The new screen slides over the old one: in from the right going in, from
    // the left coming back. Each step pushes the part already on the glass.
    static const uint8_t OFF[] = {88, 56, 32, 16, 6, 0};
    for (uint8_t off : OFF) {
      int w = W - off, src = v.slide > 0 ? 0 : off;
      tft.startWrite();
      tft.setAddrWindow(v.slide > 0 ? off : 0, 0, w, H);
      for (int y = 0; y < H; y++) {
        for (int x = 0; x < w; x++) row[x] = lut[p[y * W + src + x]];
        tft.writePixels(row, w);
      }
      tft.endWrite();
    }
    return;
  }
  tft.startWrite();
  tft.setAddrWindow(0, 0, W, H);
  for (int y = 0; y < H; y++) {
    for (int x = 0; x < W; x++) row[x] = lut[p[y * W + x]];
    tft.writePixels(row, W);
  }
  tft.endWrite();
}

#endif
