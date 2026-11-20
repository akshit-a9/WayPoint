#pragma once

// What a screen wants to show, independent of the display. The UI fills one
// View per frame; a Display decides how it looks. The OLED and the future TFT
// render the same View, and the Studio's simulator mirrors this struct.
// (The OLED's rows are 8 px, the TFT's 14 px: each Display lays out its own.)

#include <Arduino.h>

#define VIEW_ROWS 48
#define NAME_LEN 24   // a place name (NAV_NAME)

enum ViewKind {
  VIEW_MESSAGE,   // title + a few lines of text (boot, errors); scrolls like INFO
  VIEW_MENU,      // selectable list, label left, value right
  VIEW_INFO,      // read-only key/value lines, scroll with the knob
  VIEW_PATTERN,   // display test
  VIEW_TAKE,      // recording a spot: rows[0] = spot, big = countdown, progress, cue
  VIEW_NAV,       // compass: title = destination, big = distance, cue = info line, arrow at `needle`
  VIEW_HOME,      // main menu: big cards (rows: label, value = a live sub-line, icon)
  VIEW_WHERE,     // where am I: big = place, cue = sub-line, progress = confidence, rows = details
  VIEW_SPLASH,    // boot animation; progress 0..1
};

enum ViewIcon : uint8_t { ICON_NONE, ICON_NAV, ICON_PIN, ICON_TOOLS, ICON_BACK, ICON_UP, ICON_DOWN, ICON_FLAG };

// VIEW_NAV pages, chosen with the knob (View::sel)
enum NavPage : uint8_t { PAGE_COMPASS, PAGE_MAP, PAGE_STEPS, PAGE_COUNT };
#define VIEW_MAP_LINKS 64
#define VIEW_MAP_ROUTE 32

// Turn-by-turn: what to do next (VIEW_NAV)
enum Maneuver : uint8_t {
  MAN_NONE, MAN_STRAIGHT, MAN_SLIGHT_LEFT, MAN_LEFT, MAN_SLIGHT_RIGHT, MAN_RIGHT, MAN_UTURN,
  MAN_UP, MAN_DOWN, MAN_ARRIVE, MAN_LOCATING,
};

#define VIEW_NO_DIR -999

struct ViewRow {
  char label[22];
  char value[NAME_LEN];   // home cards put a place name here
  int16_t dir = VIEW_NO_DIR;   // small arrow next to the value, degrees clockwise from screen-up
  uint8_t icon = ICON_NONE;
};

struct View {
  ViewKind kind = VIEW_MESSAGE;
  char title[22] = "";
  char corner[8] = "";     // top-right of the header, e.g. "3/9" or a signal icon
  ViewRow rows[VIEW_ROWS];
  int nRows = 0;
  int sel = 0;             // VIEW_MENU: highlighted row; VIEW_INFO: first visible row
  int pattern = 0;         // VIEW_PATTERN: which test pattern
  float hold = 0;          // 0..1 hold bar along the bottom
  char toast[22] = "";     // short message over the bottom line
  char big[NAME_LEN] = ""; // large text: countdown, distance left, place name
  float progress = 0;      // VIEW_TAKE: 0..1
  char cue[22] = "";       // VIEW_TAKE: instruction line
  bool cueAlert = false;   // VIEW_TAKE: draw the cue inverted (time to turn)
  int arrow = 0;           // VIEW_TAKE: 1 = draw a turn-right arrow
  float needle = NAN;      // VIEW_NAV: arrow angle, degrees clockwise from screen-up (NAN = no arrow)
  float north = 0;         // VIEW_NAV: where north is on the dial, degrees clockwise from screen-up
  bool here = false;       // VIEW_NAV: arrived, show HERE in the dial
  // VIEW_NAV turn-by-turn card
  Maneuver man = MAN_NONE;
  char instr[20] = "";     // "Turn left"
  char instrSub[16] = "";  // "in 6 m"
  char eta[10] = "";       // "2 min"
  bool aligned = false;    // facing the way the arrow points
  uint32_t since = 0;      // millis() when this screen/state began (animations)
  bool heading = false;    // VIEW_NAV: the compass works (map turns with the device, else north up)
  // VIEW_NAV map page: decimetres from here, x right, y ahead (screen-up), on this floor
  int16_t links[VIEW_MAP_LINKS][4];   // walkable links nearby, x0 y0 x1 y1
  uint8_t nLinks = 0;
  int16_t route[VIEW_MAP_ROUTE][2];   // the route from here, up to a floor change or the end
  uint8_t nRoute = 0;
  uint8_t routeEnd = MAN_NONE;        // what's at its last point: MAN_ARRIVE, MAN_UP, MAN_DOWN
  // VIEW_NAV steps page: rows = maneuvers (label, value = distance, dir = turn, icon = floor/flag)
  // Status bar (every screen)
  int8_t bars = -1;        // WiFi signal 0..4, -1 = not connected
  bool server = false;
  // Screen change: +1 = went in (slide from the right), -1 = came back (from the left), 0 = none
  int8_t slide = 0;

  void clear() {
    nRows = 0; sel = 0; hold = 0; title[0] = corner[0] = toast[0] = 0; pattern = 0;
    big[0] = cue[0] = 0; progress = 0; cueAlert = false; arrow = 0; needle = NAN; north = 0; here = false;
    man = MAN_NONE; instr[0] = instrSub[0] = eta[0] = 0; aligned = false; since = 0;
    heading = false; nLinks = nRoute = 0; routeEnd = MAN_NONE; slide = 0;
  }
  void add(const char *label, const char *value = "", uint8_t icon = ICON_NONE, int16_t dir = VIEW_NO_DIR) {
    if (nRows >= VIEW_ROWS) return;
    strlcpy(rows[nRows].label, label, sizeof rows[nRows].label);
    strlcpy(rows[nRows].value, value, sizeof rows[nRows].value);
    rows[nRows].icon = icon;
    rows[nRows].dir = dir;
    nRows++;
  }
  void addf(const char *label, const char *fmt, ...) __attribute__((format(printf, 3, 4)));
};

/** One physical display. Add the TFT by implementing this; nothing else changes. */
class Display {
 public:
  virtual ~Display() {}
  virtual bool begin() = 0;           // false if the panel didn't answer
  virtual void draw(const View &v) = 0;
  virtual int visibleRows() const = 0; // rows of a menu/info list that fit
  virtual const char *name() const = 0;
  // Copy of the last frame for the Studio's screen mirror; returns bytes written (0 = not supported)
  virtual size_t snapshot(uint8_t *out, size_t n) { return 0; }
  // How the Studio decodes it: "1bpp" = U8g2 pages (OLED), "rle332" = [count, RGB332] pairs
  virtual const char *snapFormat() const { return "1bpp"; }
  virtual int snapWidth() const { return 128; }
  virtual int snapHeight() const { return 32; }
  // Turn the picture upside down (the panel was mounted the other way round)
  virtual void setFlip(bool flip) {}
  // Light or dark colours (the OLED has only one)
  virtual void setTheme(bool light) {}
};
