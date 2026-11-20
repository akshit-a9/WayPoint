#pragma once

// Navigation on the device. The server's nav pack (GET /api/device/nav) holds
// the site's spots, the links you can walk between them and this device's
// compass calibration. Routing is a Dijkstra over the links from the spot the
// device is at; the screen points at the next spot on the route.
//
// The network task loads packs; the UI task routes. A mutex inside keeps
// them apart, so callers get copies, never pointers into the pack.

#include <Arduino.h>

#define NAV_SPOTS 200
#define NAV_EDGES 500
#define NAV_ID 48
#define NAV_NAME 24

enum Via : uint8_t { VIA_NONE, VIA_STAIRS, VIA_LIFT, VIA_RAMP };

struct NavRoute {
  bool ok = false;        // a route exists
  bool arrived = false;
  int next = -1;          // next spot on the route
  float dist = 0;         // metres left along the route
  float brg = 0;          // compass bearing to the next spot
  int8_t floorChange = 0; // +1 up / -1 down at the next step
  Via via = VIA_NONE;     // ... and how
  float legDist = 0;      // metres from here to the next spot
  // The next maneuver along the route (turn-by-turn): where the route bends by
  // 25° or more, changes floor, or ends. manDist is measured from here.
  float manDist = 0;
  float manTurn = 0;      // degrees, + right / - left (turns only)
  int8_t manFloor = 0;    // +1 / -1: a floor change there
  Via manVia = VIA_NONE;
  bool manArrive = false; // the route ends there
};

void navInit();
bool navLoad(const String &json);   // false if it didn't parse (the old pack stays)
void navVersion(char *out, size_t n);
int navCount();
int navFind(const char *id);                 // -1 if not in the pack
int navNearest(float x, float y, int floor = -1);   // nearest spot to a site-frame point (on that floor; -1 any)
bool navSpot(int i, char *id, char *name, bool *dest);   // id: NAV_ID, name: NAV_NAME bytes
bool navSpotXy(int i, float *x, float *y);
int navFloor(int i);                         // floor index of a spot, -1 if none
int navLevel(int i);                         // its floor's level (0 = ground, 1 = first, -1 = basement)
float navRotation();                         // site frame -> compass, degrees
bool navHasDests();

// Compass heading (degrees clockwise from north) from raw magnetometer
// counts, using the Studio's calibration. NAN if the device isn't calibrated.
float navHeading(const int16_t mag[3]);

// Route lengths from `from` to every spot (INFINITY if unreachable); out has navCount() entries.
void navDistances(int from, float *out);
NavRoute navRoute(int from, int dest);
// Compass bearing and straight-line distance from a site-frame point to a spot (NAN if no spot)
float navBearingTo(float x, float y, int to, float *dist = nullptr);

// Every maneuver along the route (the steps list): a bend of 25° or more, a
// floor change, and the end. `at` is metres along the route from `from`.
struct NavStep {
  float at = 0;
  float turn = 0;        // degrees, + right / - left
  int8_t floor = 0;      // +1 up / -1 down
  Via via = VIA_NONE;
  bool arrive = false;
};
int navSteps(int from, int dest, NavStep *out, int max);
// The spots along the route, from -> dest; returns how many (0 = no route)
int navPath(int from, int dest, int16_t *out, int max);
// Links on a floor with an end within `radius` m of (x, y), as x0,y0,x1,y1 site-frame quads
int navLinks(int floor, float x, float y, float radius, float *out, int max);
