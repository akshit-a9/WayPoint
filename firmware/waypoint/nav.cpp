#include "nav.h"

#include <ArduinoJson.h>

#include "telemetry.h"

struct Spot { char id[NAV_ID]; char name[NAV_NAME]; uint8_t floor; float x, y; bool dest; };
struct Edge { uint16_t a, b; Via via; float len; };

// ~16 KB, static so loading a pack can't fragment the heap
static Spot spots[NAV_SPOTS];
static Edge edges[NAV_EDGES];
static int8_t levels[8];
static int nSpots = 0, nEdges = 0;
static float rot = 0;                 // site frame -> compass
static bool hasCal = false;
static float calOff[3], calScale[3];
static int calVert = 2;
static bool calMirror = false;
static float calHdg = 0;
static char version[12] = "";
static SemaphoreHandle_t mtx;

struct NavLock {
  NavLock() { xSemaphoreTake(mtx, portMAX_DELAY); }
  ~NavLock() { xSemaphoreGive(mtx); }
};

static float wrap360(float d) { d = fmodf(d, 360); return d < 0 ? d + 360 : d; }

void navInit() { mtx = xSemaphoreCreateMutex(); }

bool navLoad(const String &json) {
  JsonDocument doc;
  if (deserializeJson(doc, json)) { tlog("Nav pack: bad JSON (%u bytes)", json.length()); return false; }
  NavLock l;
  nSpots = nEdges = 0;
  for (JsonArray s : doc["spots"].as<JsonArray>()) {
    if (nSpots >= NAV_SPOTS) break;
    Spot &p = spots[nSpots++];
    strlcpy(p.id, s[0] | "", sizeof p.id);
    strlcpy(p.name, s[1] | "", sizeof p.name);
    p.floor = s[2] | 0;
    p.x = s[3] | 0.0f;
    p.y = s[4] | 0.0f;
    p.dest = (s[5] | 0) != 0;
  }
  for (JsonArray e : doc["edges"].as<JsonArray>()) {
    if (nEdges >= NAV_EDGES) break;
    int a = e[0] | -1, b = e[1] | -1;
    if (a < 0 || b < 0 || a >= nSpots || b >= nSpots) continue;
    edges[nEdges++] = {(uint16_t)a, (uint16_t)b, (Via)(e[2] | 0), e[3] | 0.0f};
  }
  int f = 0;
  for (JsonArray fl : doc["floors"].as<JsonArray>()) if (f < 8) levels[f++] = fl[1] | 0;
  rot = doc["rot"] | 0.0f;
  JsonArray cal = doc["cal"].as<JsonArray>();
  hasCal = cal.size() >= 9;
  if (hasCal) {
    for (int k = 0; k < 3; k++) { calOff[k] = cal[k]; calScale[k] = cal[3 + k]; }
    calVert = cal[6];
    calMirror = (cal[7] | 0) != 0;
    calHdg = cal[8];
  }
  strlcpy(version, doc["v"] | "", sizeof version);
  tlog("Nav pack %s: %s, %d spots, %d links, compass %s", version, (const char *)(doc["site"] | "?"), nSpots, nEdges,
       hasCal ? "calibrated" : "not calibrated");
  return true;
}

void navVersion(char *out, size_t n) { NavLock l; strlcpy(out, version, n); }
int navCount() { NavLock l; return nSpots; }

int navFind(const char *id) {
  if (!id || !id[0]) return -1;
  NavLock l;
  for (int i = 0; i < nSpots; i++) if (!strcmp(spots[i].id, id)) return i;
  return -1;
}

int navNearest(float x, float y, int floor) {
  NavLock l;
  int best = -1;
  float bd = INFINITY;
  for (int i = 0; i < nSpots; i++) {
    if (floor >= 0 && spots[i].floor != floor) continue;
    float d = hypotf(spots[i].x - x, spots[i].y - y);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

bool navSpot(int i, char *id, char *name, bool *dest) {
  NavLock l;
  if (i < 0 || i >= nSpots) return false;
  if (id) strlcpy(id, spots[i].id, NAV_ID);
  if (name) strlcpy(name, spots[i].name, NAV_NAME);
  if (dest) *dest = spots[i].dest;
  return true;
}

bool navSpotXy(int i, float *x, float *y) {
  NavLock l;
  if (i < 0 || i >= nSpots) return false;
  *x = spots[i].x;
  *y = spots[i].y;
  return true;
}

int navFloor(int i) {
  NavLock l;
  return i < 0 || i >= nSpots ? -1 : spots[i].floor;
}

int navLevel(int i) {
  NavLock l;
  return i < 0 || i >= nSpots ? 0 : levels[spots[i].floor & 7];
}

float navRotation() { NavLock l; return rot; }

bool navHasDests() {
  NavLock l;
  for (int i = 0; i < nSpots; i++) if (spots[i].dest) return true;
  return false;
}

// Same as the Studio's Orientation view: calibrate, take the two horizontal
// axes, atan2, then the user's mirror and "front" offset.
float navHeading(const int16_t mag[3]) {
  NavLock l;
  if (!hasCal) return NAN;
  float m[3];
  for (int k = 0; k < 3; k++) m[k] = (mag[k] - calOff[k]) * calScale[k];
  int a = calVert == 0 ? 1 : 0, b = calVert == 2 ? 1 : 2;
  float h = atan2f(m[b], m[a]) * 180 / PI;
  return wrap360((calMirror ? -h : h) + calHdg);
}

static Via edgeVia(int a, int b) {
  for (int k = 0; k < nEdges; k++)
    if ((edges[k].a == a && edges[k].b == b) || (edges[k].b == a && edges[k].a == b)) return edges[k].via;
  return VIA_NONE;
}

// Dijkstra with a linear scan for the nearest open spot: a few hundred spots at most
static void dijkstra(int from, float *len, int16_t *prev) {
  static bool done[NAV_SPOTS];
  for (int i = 0; i < nSpots; i++) { len[i] = INFINITY; prev[i] = -1; done[i] = false; }
  if (from < 0 || from >= nSpots) return;
  len[from] = 0;
  for (;;) {
    int u = -1;
    for (int i = 0; i < nSpots; i++) if (!done[i] && len[i] < INFINITY && (u < 0 || len[i] < len[u])) u = i;
    if (u < 0) break;
    done[u] = true;
    for (int k = 0; k < nEdges; k++) {
      const Edge &e = edges[k];
      int v = e.a == u ? e.b : e.b == u ? e.a : -1;
      if (v >= 0 && len[u] + e.len < len[v]) { len[v] = len[u] + e.len; prev[v] = u; }
    }
  }
}

void navDistances(int from, float *out) {
  static int16_t prev[NAV_SPOTS];
  NavLock l;
  dijkstra(from, out, prev);
}

NavRoute navRoute(int from, int dest) {
  static float len[NAV_SPOTS];
  static int16_t prev[NAV_SPOTS];
  NavRoute r;
  NavLock l;
  if (from < 0 || dest < 0 || from >= nSpots || dest >= nSpots) return r;
  if (from == dest) { r.ok = r.arrived = true; return r; }
  dijkstra(from, len, prev);
  if (!(len[dest] < INFINITY)) return r;
  // The whole path, from -> dest
  static int16_t path[NAV_SPOTS];
  int n = 0;
  for (int v = dest; v >= 0 && n < NAV_SPOTS; v = prev[v]) path[n++] = v;
  for (int i = 0; i < n / 2; i++) { int16_t t = path[i]; path[i] = path[n - 1 - i]; path[n - 1 - i] = t; }
  int next = path[1];
  r.ok = true;
  r.next = next;
  r.dist = len[dest];
  const Spot &a = spots[from], &b = spots[next];
  // Site frame: x east, y north before the anchor's rotation
  r.brg = wrap360(atan2f(b.x - a.x, b.y - a.y) * 180 / PI + rot);
  r.legDist = hypotf(b.x - a.x, b.y - a.y);
  if (a.floor != b.floor) {
    r.floorChange = levels[b.floor] > levels[a.floor] ? 1 : -1;
    r.via = edgeVia(from, next);
  }
  // The next maneuver: walk on from the next spot until the route bends, changes floor or ends
  for (int k = 1; k < n; k++) {
    r.manDist = len[path[k]];
    if (k == n - 1) { r.manArrive = true; break; }
    const Spot &p = spots[path[k - 1]], &q = spots[path[k]], &u = spots[path[k + 1]];
    if (q.floor != u.floor) {
      r.manFloor = levels[u.floor] > levels[q.floor] ? 1 : -1;
      r.manVia = edgeVia(path[k], path[k + 1]);
      break;
    }
    if (p.floor != q.floor || hypotf(q.x - p.x, q.y - p.y) < 0.3f) continue;   // no direction to turn from
    float in = atan2f(q.x - p.x, q.y - p.y), out = atan2f(u.x - q.x, u.y - q.y);
    float t = (out - in) * 180 / PI;
    while (t > 180) t -= 360;
    while (t < -180) t += 360;
    if (fabsf(t) >= 25) { r.manTurn = t; break; }
  }
  return r;
}

// Route as spot indices into path[]; caller holds the lock. Returns the count, 0 if none.
static int routePath(int from, int dest, float *len, int16_t *path, int max) {
  static int16_t prev[NAV_SPOTS];
  if (from < 0 || dest < 0 || from >= nSpots || dest >= nSpots) return 0;
  dijkstra(from, len, prev);
  if (!(len[dest] < INFINITY)) return 0;
  int n = 0;
  for (int v = dest; v >= 0; v = prev[v]) n++;
  if (n > max) return 0;
  int i = n;
  for (int v = dest; v >= 0; v = prev[v]) path[--i] = v;
  return n;
}

int navPath(int from, int dest, int16_t *out, int max) {
  static float len[NAV_SPOTS];
  NavLock l;
  return routePath(from, dest, len, out, max);
}

int navSteps(int from, int dest, NavStep *out, int max) {
  static float len[NAV_SPOTS];
  static int16_t path[NAV_SPOTS];
  NavLock l;
  int n = routePath(from, dest, len, path, NAV_SPOTS), k = 0;
  for (int i = 1; i < n && k < max; i++) {
    const Spot &q = spots[path[i - 1]], &u = spots[path[i]];
    if (q.floor != u.floor) {   // changes floor between path[i-1] and path[i]
      NavStep &s = out[k++];
      s = NavStep();
      s.at = len[path[i - 1]];
      s.floor = levels[u.floor] > levels[q.floor] ? 1 : -1;
      s.via = edgeVia(path[i - 1], path[i]);
      if (i < n - 1) continue;
      if (k >= max) break;
    }
    if (i == n - 1) { NavStep &s = out[k++]; s = NavStep(); s.at = len[path[i]]; s.arrive = true; break; }
    const Spot &w = spots[path[i + 1]];
    if (w.floor != u.floor || hypotf(u.x - q.x, u.y - q.y) < 0.3f) continue;
    float in = atan2f(u.x - q.x, u.y - q.y), outA = atan2f(w.x - u.x, w.y - u.y);
    float t = (outA - in) * 180 / PI;
    while (t > 180) t -= 360;
    while (t < -180) t += 360;
    if (fabsf(t) >= 25) { NavStep &s = out[k++]; s = NavStep(); s.at = len[path[i]]; s.turn = t; }
  }
  return k;
}

int navLinks(int floor, float x, float y, float radius, float *out, int max) {
  NavLock l;
  int k = 0;
  for (int e = 0; e < nEdges && k < max; e++) {
    const Spot &a = spots[edges[e].a], &b = spots[edges[e].b];
    if (a.floor != floor || b.floor != floor) continue;
    if (hypotf(a.x - x, a.y - y) > radius && hypotf(b.x - x, b.y - y) > radius) continue;
    float *o = out + 4 * k++;
    o[0] = a.x; o[1] = a.y; o[2] = b.x; o[3] = b.y;
  }
  return k;
}

float navBearingTo(float x, float y, int to, float *dist) {
  NavLock l;
  if (to < 0 || to >= nSpots) return NAN;
  const Spot &b = spots[to];
  if (dist) *dist = hypotf(b.x - x, b.y - y);
  return wrap360(atan2f(b.x - x, b.y - y) * 180 / PI + rot);
}
