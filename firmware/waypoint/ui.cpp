#include "ui.h"

#include <Preferences.h>
#include <stdarg.h>

#include "config.h"
#include "nav.h"
#include "net.h"
#include "secrets.h"
#include "sensors.h"
#include "state.h"
#include "telemetry.h"

enum Scr { S_MAIN, S_DESTS, S_NAV, S_WHERE, S_TOOLS, S_POSITION, S_SCAN, S_NETWORK, S_SENSORS, S_DISPLAY, S_SETTINGS, S_ABOUT };

static const char *const SCR_NAME[] = {"MAIN", "DESTINATIONS", "NAVIGATING", "WHERE AM I", "TOOLS", "POSITION", "LIVE SCAN",
                                       "NETWORK", "SENSORS", "DISPLAY TEST", "SETTINGS", "ABOUT"};

struct MenuItem { const char *label; Scr target; };

static const MenuItem MAIN_ITEMS[] = {{"Navigate", S_DESTS}, {"Where am I", S_WHERE}, {"Tools", S_TOOLS}};
static const uint8_t MAIN_ICONS[] = {ICON_NAV, ICON_PIN, ICON_TOOLS};
static const MenuItem TOOLS_ITEMS[] = {{"Back", S_MAIN},         {"Position", S_POSITION}, {"Live scan", S_SCAN},
                                       {"Network", S_NETWORK},   {"Sensors", S_SENSORS},   {"Display test", S_DISPLAY},
                                       {"Settings", S_SETTINGS}, {"About", S_ABOUT}};
enum { SET_BACK, SET_THEME, SET_HEADING, SET_TELEMETRY, SET_REBOOT, SET_COUNT };
// Heading smoothing (Settings): moving-average window
static const char *const SMOOTH[] = {"Off", "Low", "Medium", "High"};
static const uint16_t SMOOTH_MS[] = {0, 250, 500, 1000};
static uint8_t smooth = 2;
static const uint32_t SPLASH_MS = 1800;
static const float WALK_MPS = 1.2f;    // walking pace for the ETA
static bool light = false;            // light colours (Settings, or "theme" from the Studio)
static const char *const LEVELS[] = {"Off", "Basic", "Full"};

struct Frame { Scr scr; int sel; };   // sel: menu row, info scroll or test pattern

static Display *disp;
static bool tools;
static Frame stack[6];
static int depth = 0;
static int lastRows = 0;              // rows in the last built view, for clamping
static char toast[22] = "";
static uint32_t toastUntil = 0, rebootArmedUntil = 0;
static Preferences prefs;
static View view;
static Shared s;                      // snapshot of `shared` for this frame

// Navigation
static char navDest[NAV_ID] = "";     // destination spot id while on S_NAV
static int destList[VIEW_ROWS - 1];   // spot index per destination menu row (after "< BACK")
static int nDest = 0;
static float dists[NAV_SPOTS];
static float routeTotal = 0;          // route length when navigation started (progress bar)
static uint32_t navSince = 0, arrivedAt = 0;
static float shownNeedle = NAN;       // the arrow eases toward the target so compass jitter doesn't shake it
static int8_t slideNext = 0;          // the next frame slides in: +1 from the right, -1 from the left
static uint8_t screenBuf[8192];       // last frame for the Studio's mirror (TFT: run-length coded)
static size_t screenLen = 0;
static bool screenNew = false;

static Frame &top() { return stack[depth]; }

void View::addf(const char *label, const char *fmt, ...) {
  char v[sizeof rows[0].value];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(v, sizeof v, fmt, ap);
  va_end(ap);
  add(label, v);
}

static void showToast(const char *msg, uint32_t ms = 1500) {
  strlcpy(toast, msg, sizeof toast);
  toastUntil = millis() + ms;
}

static void go(Scr scr) {
  if (depth + 1 >= (int)(sizeof stack / sizeof stack[0])) return;
  stack[++depth] = {scr, 0};
  slideNext = 1;
  tevent("screen", depth, SCR_NAME[scr]);
}

static void back() {
  if (depth == 0) return;
  if (top().scr == S_NAV) { tlog("Navigation stopped"); navDest[0] = 0; }
  depth--;
  slideNext = -1;
  tevent("screen", depth, SCR_NAME[top().scr]);
}

static bool isMenu(Scr scr) { return scr == S_MAIN || scr == S_DESTS || scr == S_TOOLS || scr == S_SETTINGS; }

static int mainCount() { return tools ? 3 : 2; }

// Where the device is: a spot the Studio pretends, else the spot nearest the
// smoothed track, else the WiFi fix's spot. -1 if unknown.
static int whereNow() {
  if (s.fakeAt[0]) return navFind(s.fakeAt);
  if (s.track.ok) { int i = navNearest(s.track.x, s.track.y, s.track.floor); if (i >= 0) return i; }
  if (!s.fix.ok) return -1;
  int i = navFind(s.fix.spot);
  return i < 0 && s.fix.hasXy ? navNearest(s.fix.x, s.fix.y) : i;
}

// Compass heading, a moving average over the last SMOOTH_MS[smooth] ms. It
// averages unit vectors, not degrees, so 359° and 1° give 0°, not 180°. The
// window is in time, so it doesn't change with the frame rate.
static float headingNow() {
  if (!isnan(s.fakeHdg)) return s.fakeHdg;
  float raw = s.magOk ? navHeading(s.mag) : NAN;
  static struct { uint32_t t; float c, sn; } buf[64];   // ~2.5 s at 25 fps, more than the longest window
  static int head = 0, n = 0;
  if (isnan(raw)) { n = 0; return NAN; }
  uint32_t now = millis();
  float a = raw * PI / 180;
  buf[head] = {now, cosf(a), sinf(a)};
  head = (head + 1) % 64;
  if (n < 64) n++;
  if (!SMOOTH_MS[smooth]) return raw;
  float c = 0, sn = 0;
  for (int i = 0; i < n; i++) {
    const auto &b = buf[(head - 1 - i + 64) % 64];
    if (now - b.t > SMOOTH_MS[smooth]) break;
    c += b.c;
    sn += b.sn;
  }
  float h = atan2f(sn, c) * 180 / PI;
  return h < 0 ? h + 360 : h;
}

// The destination menu's order is fixed when it opens (nearest first), so rows
// don't jump around under the cursor as the position updates.
static void buildDests() {
  int n = navCount(), at = whereNow();
  bool onlyDests = navHasDests();   // none marked yet: list every spot
  if (at >= 0) navDistances(at, dists);
  else for (int i = 0; i < n; i++) dists[i] = INFINITY;
  nDest = 0;
  for (int i = 0; i < n && nDest < VIEW_ROWS - 1; i++) {
    bool d;
    if (navSpot(i, nullptr, nullptr, &d) && (d || !onlyDests)) destList[nDest++] = i;
  }
  // Insertion sort: reachable by distance, then the rest by name
  char a[NAV_NAME], b[NAV_NAME];
  for (int i = 1; i < nDest; i++) {
    for (int j = i; j > 0; j--) {
      int p = destList[j - 1], q = destList[j];
      bool swap;
      if (dists[p] != dists[q]) swap = dists[q] < dists[p];
      else { navSpot(p, nullptr, a, nullptr); navSpot(q, nullptr, b, nullptr); swap = strcasecmp(b, a) < 0; }
      if (!swap) break;
      destList[j - 1] = q; destList[j] = p;
    }
  }
}

static void startNav(const char *id) {
  strlcpy(navDest, id, sizeof navDest);
  routeTotal = 0;
  navSince = millis();
  arrivedAt = 0;
  shownNeedle = NAN;
  char name[NAV_NAME] = "";
  navSpot(navFind(id), nullptr, name, nullptr);
  tlog("Navigating to %s", name[0] ? name : id);
  if (top().scr != S_NAV) go(S_NAV);
}

// "5:42" from the server's clock; false until the first telemetry reply
static bool clockText(char *out, size_t n) {
  if (!s.clock) return false;
  uint32_t t = s.clock + (millis() - s.clockAt) / 1000;
  int h = t / 3600 % 24, m = t / 60 % 60;
  snprintf(out, n, "%d:%02d", h % 12 ? h % 12 : 12, m);
  return true;
}

static const char *age(uint32_t at, char *buf, size_t n) {
  uint32_t sec = (millis() - at) / 1000;
  if (sec < 60) snprintf(buf, n, "%lus", (unsigned long)sec);
  else snprintf(buf, n, "%lum", (unsigned long)(sec / 60));
  return buf;
}

// ---------------------------------------------------------------------------
// Building views
// ---------------------------------------------------------------------------
static void menuView(const char *title, const MenuItem *items, int n) {
  view.kind = VIEW_MENU;
  strlcpy(view.title, title, sizeof view.title);
  for (int i = 0; i < n; i++) view.add(items[i].label, "", items[i].target == S_MAIN ? ICON_BACK : ICON_NONE);
}

// Where the device is, as a site-frame point: the smoothed track, else the spot it's at
static bool hereXy(int at, float &x, float &y) {
  if (s.track.ok && !s.fakeAt[0]) { x = s.track.x; y = s.track.y; return true; }
  return at >= 0 && navSpotXy(at, &x, &y);
}

// Main menu: each card says something live
static void homeView() {
  view.kind = VIEW_HOME;
  strlcpy(view.title, "WayPoint", sizeof view.title);
  clockText(view.corner, sizeof view.corner);
  char sub[12];
  int places = 0;
  bool d, onlyDests = navHasDests();
  for (int i = 0; i < navCount(); i++) if (navSpot(i, nullptr, nullptr, &d) && (d || !onlyDests)) places++;
  if (!navCount()) strlcpy(sub, s.serverUp ? "map loading" : "no map yet", sizeof sub);
  else snprintf(sub, sizeof sub, "%d places", places);
  view.add(MAIN_ITEMS[0].label, sub, MAIN_ICONS[0]);
  int at = whereNow();
  char name[NAV_NAME] = "";
  if (at >= 0) navSpot(at, nullptr, name, nullptr);
  else strlcpy(name, !s.wifiUp ? "no WiFi" : s.fix.at ? "not sure" : "locating...", sizeof name);
  view.add(MAIN_ITEMS[1].label, name, MAIN_ICONS[1]);
  if (mainCount() > 2) view.add(MAIN_ITEMS[2].label, "v" FW_VERSION, MAIN_ICONS[2]);
}

static void whereView() {
  const Fix &f = s.fix;
  char a[8], buf[24];
  view.kind = VIEW_WHERE;
  strlcpy(view.title, "Where am I", sizeof view.title);
  clockText(view.corner, sizeof view.corner);
  if (!s.wifiUp) { strlcpy(view.big, "No WiFi", sizeof view.big); snprintf(view.cue, sizeof view.cue, "joining %s", WIFI_SSID); return; }
  if (!f.at) { strlcpy(view.big, "Scanning", sizeof view.big); strlcpy(view.cue, "listening for WiFi...", sizeof view.cue); return; }
  if (!f.ok) { strlcpy(view.big, "Not sure", sizeof view.big); strlcpy(view.cue, f.error, sizeof view.cue); return; }
  int at = whereNow();
  char name[NAV_NAME] = "";
  if (at >= 0) navSpot(at, nullptr, name, nullptr);
  strlcpy(view.big, name[0] ? name : f.location, sizeof view.big);
  snprintf(view.cue, sizeof view.cue, "updated %s ago", age(f.at, a, sizeof a));
  view.progress = f.confidence;
  if (s.track.ok) view.addf("Accuracy", "+/-%.0f m", max(1.0f, s.track.sigma));
  view.addf("Steps", "%lu%s", (unsigned long)s.track.steps, s.track.moving ? " walking" : "");
  snprintf(buf, sizeof buf, "%d/%d", f.knownAps, f.totalAps);
  view.add("WiFi seen", buf);
}

// Destinations, nearest first: distance along the route, and a little arrow
// pointing at each one (straight line) as the device is held
static void destsView() {
  view.kind = VIEW_MENU;
  strlcpy(view.title, "Go to", sizeof view.title);
  view.add("Back", "", ICON_BACK);
  if (!navCount()) { view.add(s.serverUp ? "Map loading..." : "No map: server?"); return; }
  int at = whereNow();
  if (at >= 0) navDistances(at, dists);
  float hx, hy, hdg = headingNow();
  bool here = hereXy(at, hx, hy);
  char name[NAV_NAME], d[12];
  for (int i = 0; i < nDest; i++) {
    navSpot(destList[i], nullptr, name, nullptr);
    float m = at >= 0 ? dists[destList[i]] : INFINITY;
    if (destList[i] == at) strlcpy(d, "here", sizeof d);
    else if (m < INFINITY) snprintf(d, sizeof d, "%dm", (int)(m + 0.5f));
    else strlcpy(d, at >= 0 ? "--" : "", sizeof d);
    int16_t dir = VIEW_NO_DIR;
    float straight;
    if (here && destList[i] != at) {
      float b = navBearingTo(hx, hy, destList[i], &straight);
      if (!isnan(b) && straight > 1) dir = (int16_t)lroundf(isnan(hdg) ? b : b - hdg);
    }
    view.add(name, d, ICON_NONE, dir);
  }
}

static float wrap180(float d) {
  d = fmodf(d, 360);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// "Turn left" / "Bear right" / ... from a turn angle at the next maneuver
static Maneuver turnOf(float t) {
  float a = fabsf(t);
  if (a < 25) return MAN_STRAIGHT;
  if (a < 60) return t < 0 ? MAN_SLIGHT_LEFT : MAN_SLIGHT_RIGHT;
  if (a < 140) return t < 0 ? MAN_LEFT : MAN_RIGHT;
  return MAN_UTURN;
}

static const char *manText(Maneuver m) {
  switch (m) {
    case MAN_STRAIGHT: return "Straight";
    case MAN_SLIGHT_LEFT: return "Bear left";
    case MAN_LEFT: return "Turn left";
    case MAN_SLIGHT_RIGHT: return "Bear right";
    case MAN_RIGHT: return "Turn right";
    case MAN_UTURN: return "Turn back";
    case MAN_ARRIVE: return "Arrive";
    default: return "";
  }
}

static void distText(char *out, size_t n, float m) {
  if (m < 1.5f) strlcpy(out, "now", n);
  else snprintf(out, n, "in %d m", (int)(m + 0.5f));
}

// Map page: links nearby and the route, around here, turned so ahead is up
static void mapPage(int at, int dest, float hdg) {
  float hx, hy;
  if (!hereXy(at, hx, hy)) return;
  float th = (navRotation() - (isnan(hdg) ? 0 : hdg)) * PI / 180, c = cosf(th), sn = sinf(th);   // hdg is already smoothed
  auto put = [&](float x, float y, int16_t *o) {   // site frame -> decimetres, x right / y ahead
    float dx = x - hx, dy = y - hy;
    o[0] = (int16_t)constrain((dx * c + dy * sn) * 10, -30000.0f, 30000.0f);
    o[1] = (int16_t)constrain((dy * c - dx * sn) * 10, -30000.0f, 30000.0f);
  };
  static float seg[VIEW_MAP_LINKS * 4];
  int floor = navFloor(at);
  int n = navLinks(floor, hx, hy, 40, seg, VIEW_MAP_LINKS);
  for (int i = 0; i < n; i++) { put(seg[4 * i], seg[4 * i + 1], view.links[i]); put(seg[4 * i + 2], seg[4 * i + 3], view.links[i] + 2); }
  view.nLinks = n;
  static int16_t path[NAV_SPOTS];
  int np = navPath(at, dest, path, NAV_SPOTS);
  view.route[0][0] = view.route[0][1] = 0;
  view.nRoute = 1;
  view.routeEnd = MAN_NONE;
  for (int i = 1; i < np && view.nRoute < VIEW_MAP_ROUTE; i++) {
    if (navFloor(path[i]) != floor) { view.routeEnd = navLevel(path[i]) > navLevel(path[i - 1]) ? MAN_UP : MAN_DOWN; break; }
    float x, y;
    navSpotXy(path[i], &x, &y);
    put(x, y, view.route[view.nRoute++]);
    if (i == np - 1) view.routeEnd = MAN_ARRIVE;
  }
}

// Steps page: every maneuver left, with the distance to it
static void stepsPage(int at, int dest, float done) {
  static const char *const VIA[] = {"Go", "Stairs", "Lift", "Ramp"};
  static NavStep st[VIEW_ROWS];
  int n = navSteps(at, dest, st, VIEW_ROWS);
  char label[22], d[12];
  for (int i = 0; i < n; i++) {
    snprintf(d, sizeof d, "%d m", (int)(max(0.0f, st[i].at - done) + 0.5f));
    if (st[i].arrive) view.add("Arrive", d, ICON_FLAG);
    else if (st[i].floor) {
      snprintf(label, sizeof label, "%s %s", VIA[st[i].via], st[i].floor > 0 ? "up" : "down");
      view.add(label, d, st[i].floor > 0 ? ICON_UP : ICON_DOWN);
    } else view.add(manText(turnOf(st[i].turn)), d, ICON_NONE, (int16_t)lroundf(st[i].turn));
  }
}

// The compass: the arrow points at the next spot on the route, turned by the
// device's heading so it points the right way in the real world. Without a
// compass the dial stays north-up and the arrow shows the bearing.
static void navView() {
  view.kind = VIEW_NAV;
  int dest = navFind(navDest), at = whereNow();
  float hdg = headingNow();
  char name[NAV_NAME] = "";
  if (!navSpot(dest, nullptr, name, nullptr)) strlcpy(name, navDest, sizeof name);
  strlcpy(view.title, name, sizeof view.title);
  view.north = isnan(hdg) ? 0 : -hdg;
  view.man = MAN_LOCATING;
  NavRoute r;
  static const char *const VIA[] = {"Go", "Stairs", "Lift", "Ramp"};
  if (dest < 0) { strlcpy(view.instr, "Not on map", sizeof view.instr); strlcpy(view.instrSub, "pick again", sizeof view.instrSub); strlcpy(view.big, "--", sizeof view.big); }
  else if (at < 0) { strlcpy(view.instr, "Locating", sizeof view.instr); strlcpy(view.instrSub, "walk a few steps", sizeof view.instrSub); strlcpy(view.big, "--", sizeof view.big); }
  else if (!(r = navRoute(at, dest)).ok) { strlcpy(view.instr, "No route", sizeof view.instr); strlcpy(view.instrSub, "no links there", sizeof view.instrSub); strlcpy(view.big, "--", sizeof view.big); }
  else if (r.arrived) {
    if (!arrivedAt) { arrivedAt = millis(); tlog("Arrived at %s", name); }
    view.here = true;
    view.since = arrivedAt;
  } else {
    arrivedAt = 0;
    // How far along the first leg the smoothed track already is
    float done = 0, hx, hy;
    if (s.track.ok && !s.fakeAt[0] && hereXy(at, hx, hy)) {
      float left;
      navBearingTo(hx, hy, r.next, &left);
      done = constrain(r.legDist - left, 0.0f, r.legDist);
    }
    float remaining = max(0.0f, r.dist - done), toMan = max(0.0f, r.manDist - done);
    if (remaining > routeTotal) routeTotal = remaining;
    view.progress = routeTotal > 0 ? 1 - remaining / routeTotal : 0;
    snprintf(view.big, sizeof view.big, "%d m", (int)(remaining + 0.5f));
    int min_ = (int)(remaining / WALK_MPS / 60 + 0.5f);
    if (min_ < 1) strlcpy(view.eta, "< 1 min", sizeof view.eta);
    else snprintf(view.eta, sizeof view.eta, "%d min", min_);

    // The arrow eases toward the target: the compass jitters a few degrees
    float target = isnan(hdg) ? r.brg : r.brg - hdg;
    shownNeedle = isnan(shownNeedle) ? target : shownNeedle + wrap180(target - shownNeedle) * 0.3f;
    view.needle = roundf(shownNeedle / 2) * 2;
    float off = isnan(hdg) ? 0 : wrap180(r.brg - hdg);
    view.aligned = !isnan(hdg) && fabsf(off) < 20;
    if (isnan(hdg)) strlcpy(view.cue, "north up", sizeof view.cue);

    // What to do: change floor here, face the route, or the next maneuver
    if (r.floorChange) {
      view.man = r.floorChange > 0 ? MAN_UP : MAN_DOWN;
      snprintf(view.instr, sizeof view.instr, "%s %s", VIA[r.via], r.floorChange > 0 ? "up" : "down");
      strlcpy(view.instrSub, "here", sizeof view.instrSub);
    } else if (!isnan(hdg) && fabsf(off) >= 50) {
      view.man = fabsf(off) >= 140 ? MAN_UTURN : off < 0 ? MAN_LEFT : MAN_RIGHT;
      strlcpy(view.instr, fabsf(off) >= 140 ? "Turn around" : off < 0 ? "Turn left" : "Turn right", sizeof view.instr);
      strlcpy(view.instrSub, "face the arrow", sizeof view.instrSub);
    } else if (r.manArrive) {
      view.man = MAN_ARRIVE;
      strlcpy(view.instr, "Arrive", sizeof view.instr);
      distText(view.instrSub, sizeof view.instrSub, toMan);
    } else if (r.manFloor) {
      view.man = r.manFloor > 0 ? MAN_UP : MAN_DOWN;
      snprintf(view.instr, sizeof view.instr, "%s %s", VIA[r.manVia], r.manFloor > 0 ? "up" : "down");
      distText(view.instrSub, sizeof view.instrSub, toMan);
    } else {
      view.man = turnOf(r.manTurn);
      strlcpy(view.instr, manText(view.man), sizeof view.instr);
      distText(view.instrSub, sizeof view.instrSub, toMan);
    }
    view.heading = !isnan(hdg);
    if (top().sel == PAGE_MAP) mapPage(at, dest, hdg);
    else if (top().sel == PAGE_STEPS) stepsPage(at, dest, done);
  }

  Lock l;
  strlcpy(shared.nav.dest, navDest, sizeof shared.nav.dest);
  if (!navSpot(at, shared.nav.at, nullptr, nullptr)) shared.nav.at[0] = 0;
  if (!navSpot(r.next, shared.nav.next, nullptr, nullptr)) shared.nav.next[0] = 0;
  strlcpy(shared.nav.cue, r.floorChange ? view.instr : "", sizeof shared.nav.cue);
  shared.nav.dist = r.dist;
  shared.nav.brg = r.brg;
  shared.nav.hdg = hdg;
  shared.nav.arrived = r.arrived;
}

static void positionView() {
  const Fix &f = s.fix;
  char a[8], label[22];
  view.kind = VIEW_INFO;
  strlcpy(view.title, "Position", sizeof view.title);
  if (!f.at) { view.add("No fix yet"); return; }
  if (!f.ok) { view.add(f.error); view.add("Age", age(f.at, a, sizeof a)); return; }
  view.add("Spot", f.spot);
  view.addf("Confidence", "%d%%", (int)(f.confidence * 100 + 0.5f));
  view.addf("Known APs", "%d/%d", f.knownAps, f.totalAps);
  if (f.hasXy) view.addf("x,y m", "%.1f,%.1f", f.x, f.y);
  if (s.track.ok) view.addf("Track", "%.1f,%.1f", s.track.x, s.track.y);
  view.addf("Steps", "%lu%s", (unsigned long)s.track.steps, s.track.moving ? " walk" : "");
  view.addf("Latency", "%u ms", f.latencyMs);
  view.add("Age", age(f.at, a, sizeof a));
  for (int i = 0; i < f.nTop; i++) {
    snprintf(label, sizeof label, "#%d %.14s", i + 1, f.topSpot[i]);
    view.addf(label, "%d%%", (int)(f.topP[i] * 100 + 0.5f));
  }
}

static void scanView() {
  char label[22];
  view.kind = VIEW_INFO;
  strlcpy(view.title, "Live scan", sizeof view.title);
  snprintf(view.corner, sizeof view.corner, "%d", s.nAps);
  if (!s.scans) { view.add("No scan yet"); return; }
  snprintf(label, sizeof label, "Scan #%lu", (unsigned long)s.scans);
  view.addf(label, "%u ms", s.lastScanMs);
  for (int i = 0; i < s.nAps && view.nRows < VIEW_ROWS; i++) {
    const Ap &ap = s.aps[i];
    snprintf(label, sizeof label, "%.15s", ap.ssid[0] ? ap.ssid : ap.bssid + 6);
    view.addf(label, "%d c%d", ap.rssi, ap.channel);
  }
}

static void networkView() {
  char label[22];
  view.kind = VIEW_INFO;
  strlcpy(view.title, "Network", sizeof view.title);
  view.add("WiFi", s.wifiUp ? "up" : "down");
  snprintf(label, sizeof label, "SSID %s", WIFI_SSID);
  view.add(label);
  snprintf(label, sizeof label, "IP %s", s.wifiUp ? s.ip : "-");
  view.add(label);
  if (s.wifiUp) { view.addf("Signal", "%d dBm", s.wifiRssi); view.addf("Channel", "%d", s.wifiChannel); }
  view.add("Server", s.serverUp ? "ok" : "down");
  snprintf(label, sizeof label, "%s", API_BASE_URL + 7);   // skip "http://"
  view.add(label);
  view.add("Site", s.site[0] ? s.site : "?");
  view.addf("Scans", "%lu", (unsigned long)s.scans);
  view.addf("Telemetry", "%s", LEVELS[s.telemetryLevel]);
  view.addf("  sent", "%lu", (unsigned long)s.telemetrySent);
  view.addf("  failed", "%lu", (unsigned long)s.telemetryFailed);
  snprintf(label, sizeof label, "ID %s", deviceId());
  view.add(label);
}

static void sensorsView() {
  char label[22] = "I2C";
  view.kind = VIEW_INFO;
  strlcpy(view.title, "Sensors", sizeof view.title);
  strlcpy(view.corner, "click:scan", sizeof view.corner);
  for (int i = 0; i < s.nI2c; i++) snprintf(label + strlen(label), sizeof label - strlen(label), " %02X", s.i2cFound[i]);
  view.add(s.nI2c ? label : "I2C: nothing found");
  view.addf("Mag 2C", s.magOk ? "ok id %02X" : "missing", s.magChipId);
  if (s.magOk) {
    view.addf("  X", "%d", s.mag[0]); view.addf("  Y", "%d", s.mag[1]); view.addf("  Z", "%d", s.mag[2]);
  }
  view.addf("MPU 68", s.mpuOk ? "ok id %02X" : "missing", s.mpuWhoAmI);
  if (s.mpuOk) {
    view.addf("  Acc X", "%d", s.acc[0]); view.addf("  Acc Y", "%d", s.acc[1]); view.addf("  Acc Z", "%d", s.acc[2]);
  }
#if DISPLAY_TFT
  view.add("TFT", "SPI");
#else
  view.add("OLED 3C", s.oledOk ? "ok" : "no ack");
#endif
  view.addf("I2C errors", "%lu", (unsigned long)s.i2cErrors);
  view.addf("Frame rate", "%.0f fps", s.fps);
}

static void settingsView() {
  view.kind = VIEW_MENU;
  strlcpy(view.title, "Settings", sizeof view.title);
  view.add("Back", "", ICON_BACK);
  view.add("Theme", light ? "Light" : "Dark");
  view.add("Heading", SMOOTH[smooth]);
  view.add("Telemetry", LEVELS[s.telemetryLevel]);
  view.add("Reboot", millis() < rebootArmedUntil ? "again!" : "");
}

static void aboutView() {
  char label[22];
  view.kind = VIEW_INFO;
  strlcpy(view.title, "About", sizeof view.title);
  view.add("WayPoint", FW_VERSION);
  view.add("Build", PRODUCTION ? "production" : "dev");
  snprintf(label, sizeof label, "%s", __DATE__);
  view.add("Built", label);
  view.add(disp->name());
  view.addf("Uptime", "%lus", (unsigned long)(millis() / 1000));
  view.addf("Free heap", "%luk", (unsigned long)(ESP.getFreeHeap() / 1024));
  view.add("Tools", tools ? "unlocked" : "locked");
}

// While the Studio records a take on this device, the screen only shows its
// progress: time left, which way to face, and when it's done. Controls stay in
// the Studio. Turn 45° right at each eighth of the take (8 headings in all).
static bool takeShowing() { return s.take.active && millis() - s.take.seenMs < 5000; }

static void takeView() {
  const Take &t = s.take;
  float e = (millis() - t.startMs) / 1000.0f;
  view.kind = VIEW_TAKE;
  strlcpy(view.title, t.done ? "SAVED" : "REC", sizeof view.title);
  snprintf(view.corner, sizeof view.corner, "%d sc", t.scans);
  char spot[14];
  strlcpy(spot, t.spot, sizeof spot);   // fits the header next to the state and scans
  view.add(spot);
  view.progress = t.done ? 1 : e / t.seconds;
  if (t.done) {
    strlcpy(view.big, "DONE", sizeof view.big);
    strlcpy(view.cue, "Pick the next spot", sizeof view.cue);
    return;
  }
  if (e >= t.seconds) {
    strlcpy(view.big, "0s", sizeof view.big);
    strlcpy(view.cue, "Saving...", sizeof view.cue);
    return;
  }
  snprintf(view.big, sizeof view.big, "%ds", (int)(t.seconds - e + 0.99f));
  int turnNo = (int)(e / t.turnEvery);
  bool turning = turnNo >= 1 && turnNo <= 7 && e - turnNo * t.turnEvery < 2.5f;
  if (turning) {
    strlcpy(view.cue, "TURN 45\xB0 RIGHT", sizeof view.cue);
    view.cueAlert = (millis() / 250) % 2;   // blink
    view.arrow = 1;
  } else {
    snprintf(view.cue, sizeof view.cue, "Hold still  %d/8", turnNo + 1);
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
static void setLevel(uint8_t level) {
  { Lock l; shared.telemetryLevel = level; }
  prefs.putUChar("tlevel", level);
  tlog("Telemetry level set to %s", LEVELS[level]);
}

static void setLight(bool on) {
  light = on;
  disp->setTheme(on);
  prefs.putBool("light", on);
  tlog("Theme %s", on ? "light" : "dark");
}

static void click() {
  Frame &f = top();
  tevent("click", f.sel, SCR_NAME[f.scr]);
  switch (f.scr) {
    case S_MAIN:
      if (MAIN_ITEMS[f.sel].target == S_DESTS) buildDests();
      go(MAIN_ITEMS[f.sel].target);
      break;
    case S_DESTS:
      if (f.sel == 0) back();
      else if (f.sel - 1 < nDest) { char id[NAV_ID]; if (navSpot(destList[f.sel - 1], id, nullptr, nullptr)) startNav(id); }
      break;
    case S_TOOLS: if (f.sel == 0) back(); else go(TOOLS_ITEMS[f.sel].target); break;
    case S_SETTINGS:
      if (f.sel == SET_BACK) back();
      else if (f.sel == SET_THEME) setLight(!light);
      else if (f.sel == SET_HEADING) {
        smooth = (smooth + 1) % 4;
        prefs.putUChar("hsmooth", smooth);
        tlog("Heading smoothing %s (%u ms)", SMOOTH[smooth], SMOOTH_MS[smooth]);
      }
      else if (f.sel == SET_TELEMETRY) setLevel((s.telemetryLevel + 1) % 3);
      else if (f.sel == SET_REBOOT) {
        if (millis() < rebootArmedUntil) { tlog("Reboot from Settings"); delay(300); ESP.restart(); }
        rebootArmedUntil = millis() + 3000;
        showToast("Click again to reboot", 3000);
      }
      break;
    case S_SENSORS: sensorsScanBus(); showToast("Bus rescanned"); break;
    case S_DISPLAY: f.sel = (f.sel + 1) % 4; break;
    case S_NAV:   // arrived: done, back to the main menu
      if (arrivedAt) { navDest[0] = 0; arrivedAt = 0; depth = 0; slideNext = -1; tevent("screen", 0, SCR_NAME[S_MAIN]); }
      else back();
      break;
    default: back(); break;   // read-only screens: click also goes back
  }
}

void uiInput(const InputEvent &e) {
  if (takeShowing()) return;   // the Studio is in charge while recording
  Frame &f = top();
  if (e.type == IN_HOLD) { tevent("hold", 0, SCR_NAME[f.scr]); back(); return; }
  if (e.type == IN_CLICK) { click(); return; }
  if (e.type != IN_TURN) return;

  int steps = e.steps;
  if (abs(steps) >= 3) steps *= 2;   // spinning fast skips through long lists
  tevent("turn", steps);
  if (f.scr == S_DISPLAY) { f.sel = ((f.sel + steps) % 4 + 4) % 4; return; }
  if (f.scr == S_NAV) {   // compass / map / steps, one page a detent
    int p = constrain(f.sel + (steps > 0 ? 1 : -1), 0, PAGE_COUNT - 1);
    if (p != f.sel && !arrivedAt) { slideNext = p > f.sel ? 1 : -1; f.sel = p; }
    return;
  }
  int vis = disp->visibleRows();
  int max = isMenu(f.scr) ? lastRows - 1 : lastRows - vis;
  f.sel = constrain(f.sel + steps, 0, max > 0 ? max : 0);
}

// ---------------------------------------------------------------------------
void uiInit(Display &display, bool toolsUnlocked) {
  disp = &display;
  tools = toolsUnlocked;
  prefs.begin("waypoint");
  uint8_t level = min<uint8_t>(prefs.getUChar("tlevel", PRODUCTION ? 1 : 2), 2);
  { Lock l; shared.telemetryLevel = level; }  stack[0] = {S_MAIN, 0};
  if (prefs.getBool("flip", TFT_FLIP)) disp->setFlip(true);
  light = prefs.getBool("light", false);
  smooth = min<uint8_t>(prefs.getUChar("hsmooth", 2), 3);
  disp->setTheme(light);
  if (tools) tlog("Tools unlocked");
}

size_t uiScreen(uint8_t *out, size_t n, ScreenInfo *info) {
  Lock l;
  if (!screenNew || screenLen > n) return 0;
  memcpy(out, screenBuf, screenLen);
  info->format = disp->snapFormat();
  info->w = disp->snapWidth();
  info->h = disp->snapHeight();
  screenNew = false;
  return screenLen;
}

void uiDraw() {
  char navCmd[NAV_ID];
  int8_t knob[8], flip, theme;
  uint8_t nKnob;
  {
    Lock l;
    s = shared;
    if (shared.toast[0]) {   // from the Studio
      strlcpy(toast, shared.toast, sizeof toast);
      toastUntil = shared.toastUntil;
      shared.toast[0] = 0;
    }
    strlcpy(navCmd, shared.navCmd, sizeof navCmd);
    shared.navCmd[0] = 0;
    nKnob = shared.nKnob;
    memcpy(knob, shared.knob, nKnob);
    shared.nKnob = 0;
    flip = shared.wantFlip;
    shared.wantFlip = -1;
    theme = shared.wantTheme;
    shared.wantTheme = -1;
  }
  if (flip >= 0) { disp->setFlip(flip); prefs.putBool("flip", flip); tlog("Screen flip %s", flip ? "on" : "off"); }
  if (theme >= 0) setLight(theme);
  // Studio: start or stop navigating, and knob events for testing without one
  if (!strcmp(navCmd, "stop")) { if (top().scr == S_NAV) back(); }
  else if (navCmd[0]) {
    if (top().scr != S_DESTS && top().scr != S_NAV) { depth = 0; buildDests(); go(S_DESTS); }
    startNav(navCmd);
  }
  for (int i = 0; i < nKnob; i++) {
    InputEvent e;
    if (knob[i] == KNOB_CLICK) e.type = IN_CLICK;
    else if (knob[i] == KNOB_HOLD) e.type = IN_HOLD;
    else { e.type = IN_TURN; e.steps = knob[i]; }
    uiInput(e);
  }
  if (!navDest[0]) { Lock l; shared.nav.dest[0] = 0; }

  Frame &f = top();
  view.clear();
  // Status bar on every screen
  view.bars = !s.wifiUp ? -1 : s.wifiRssi > -55 ? 4 : s.wifiRssi > -65 ? 3 : s.wifiRssi > -75 ? 2 : 1;
  view.server = s.serverUp;
  if (millis() < SPLASH_MS) {
    view.kind = VIEW_SPLASH;
    view.progress = millis() / (float)SPLASH_MS;
    strlcpy(view.cue, "v" FW_VERSION, sizeof view.cue);
    disp->draw(view);
    return;
  }
  if (takeShowing()) {
    takeView();
    disp->draw(view);
    Lock l;
    shared.screen = "RECORDING";
    return;
  }
  switch (f.scr) {
    case S_MAIN: homeView(); break;
    case S_DESTS: destsView(); break;
    case S_NAV: navView(); break;
    case S_TOOLS: menuView("Tools", TOOLS_ITEMS, sizeof TOOLS_ITEMS / sizeof TOOLS_ITEMS[0]); break;
    case S_WHERE: whereView(); break;
    case S_POSITION: positionView(); break;
    case S_SCAN: scanView(); break;
    case S_NETWORK: networkView(); break;
    case S_SENSORS: sensorsView(); break;
    case S_DISPLAY: view.kind = VIEW_PATTERN; view.pattern = f.sel; break;
    case S_SETTINGS: settingsView(); break;
    case S_ABOUT: aboutView(); break;
  }
  lastRows = view.nRows;
  int vis = disp->visibleRows();
  int max = isMenu(f.scr) ? view.nRows - 1 : view.nRows - vis;
  if (f.scr != S_DISPLAY && f.scr != S_NAV) f.sel = constrain(f.sel, 0, max > 0 ? max : 0);
  view.sel = f.sel;
  if (!view.corner[0] && view.kind == VIEW_MENU && view.nRows > vis)
    snprintf(view.corner, sizeof view.corner, "%d/%d", f.sel + 1, view.nRows);
  if (millis() < toastUntil) strlcpy(view.toast, toast, sizeof view.toast);
  view.slide = slideNext;
  slideNext = 0;
  view.hold = depth > 0 ? inputHoldProgress() : 0;
  disp->draw(view);

  // About one picture a second for the Studio while it asks for them
  static uint32_t lastShot = 0;
  bool shot = (int32_t)(s.screenUntil - millis()) > 0 && millis() - lastShot > 900;
  Lock l;
  if (shot && (screenLen = disp->snapshot(screenBuf, sizeof screenBuf))) { screenNew = true; lastShot = millis(); }
  shared.screen = SCR_NAME[f.scr];
  shared.sel = f.sel;
}
