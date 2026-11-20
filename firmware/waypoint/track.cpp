#include "track.h"

#include "config.h"
#include "nav.h"
#include "state.h"
#include "telemetry.h"

#define ACC_PER_G 16384.0f   // MPU-6050 at ±2 g

// Step detector: the acceleration's size minus gravity, smoothed a little.
// A peak is a rise over STEP_HIGH g that falls back below zero. Walking makes
// peaks in a rhythm, so a peak counts only when another follows within
// STEP_MAX_GAP_MS (the first of a walk is counted then too); a lone knock doesn't.
static float gravity = 1, bounce = 0;
static bool rising = false, pending = false;
static uint32_t lastPeak = 0, lastStep = 0;

// Track: position in the site frame (metres), its variance, the floor it's on
static bool have = false;
static float px, py, P;
static int floor_ = -1, floorVotes = 0, misses = 0;
static uint32_t lastFix = 0, lastGrow = 0, steps = 0;

static void put(float x, float y, float var) { px = x; py = y; P = var; misses = 0; }

// Steps taken since the last call: 0, 1, or 2 when a walk's first peak is confirmed
static int stepsNow(const int16_t acc[3], uint32_t now) {
  float a = sqrtf((float)acc[0] * acc[0] + (float)acc[1] * acc[1] + (float)acc[2] * acc[2]) / ACC_PER_G;
  if (a < 0.2f || a > 3.5f) return 0;       // a bad read
  gravity += (a - gravity) * 0.02f;           // ~1 s
  bounce += (a - gravity - bounce) * 0.35f;   // takes the edge off the noise
  if (bounce > STEP_HIGH_G) rising = true;
  else if (rising && bounce < 0) {
    rising = false;
    uint32_t gap = now - lastPeak;
    if (gap < STEP_MIN_MS) return 0;          // the same step ringing
    lastPeak = now;
    if (gap > STEP_MAX_GAP_MS) { pending = true; return 0; }   // maybe a knock: wait for the next
    int n = pending ? 2 : 1;
    pending = false;
    lastStep = now;
    return n;
  }
  return 0;
}

// WiFi fix -> how far off it may be (metres, 1 sigma)
static float fixSigma(float conf, bool moving) {
  float s = TRACK_FIX_SIGMA_M + 6 * (1 - constrain(conf, 0.0f, 1.0f));
  return moving ? s : s * 2;   // standing still: trust the steps (none) over WiFi noise
}

void trackUpdate(uint32_t now) {
  int16_t acc[3], mag[3];
  bool accOk, magOk;
  float fakeHdg;
  Fix f;
  {
    Lock l;
    memcpy(acc, shared.acc, sizeof acc);
    memcpy(mag, shared.mag, sizeof mag);
    accOk = shared.mpuOk;
    magOk = shared.magOk;
    fakeHdg = shared.fakeHdg;
    if (shared.fix.at != lastFix) f = shared.fix;
  }
  bool moving = now - lastStep < 4000;

  int n = accOk ? stepsNow(acc, now) : 0;
  if (n) {
    steps += n;
    float hdg = !isnan(fakeHdg) ? fakeHdg : magOk ? navHeading(mag) : NAN;
    if (have && !isnan(hdg)) {
      float t = (hdg - navRotation()) * PI / 180;   // compass -> site frame
      px += n * STRIDE_M * sinf(t);
      py += n * STRIDE_M * cosf(t);
      P += n * 0.15f;                               // stride and heading errors
    } else if (have) P += n * STRIDE_M * STRIDE_M;  // moved, but which way?
  }
  // A little doubt creeps in with time, so a track that went wrong recovers
  if (now - lastGrow >= 1000) { lastGrow = now; if (have) P += 0.02f; }

  if (f.at && f.at != lastFix) {
    lastFix = f.at;
    int spot = navFind(f.spot);
    if (spot < 0 && f.hasXy) spot = navNearest(f.x, f.y, -1);
    float fx = f.x, fy = f.y;
    bool ok = f.ok && (f.hasXy || navSpotXy(spot, &fx, &fy));
    int fl = navFloor(spot);
    if (ok) {
      float s = fixSigma(f.confidence, moving), R = s * s;
      if (!have) { have = true; floor_ = fl; put(fx, fy, R); }
      else if (fl != floor_) {
        // Another floor: believe it once it says so twice in a row
        if (++floorVotes >= 2) { floor_ = fl; floorVotes = 0; put(fx, fy, R); }
      } else {
        floorVotes = 0;
        float dx = fx - px, dy = fy - py, gate = 3 * sqrtf(P + R);
        if (dx * dx + dy * dy > gate * gate) {
          if (++misses >= 3) { tlog("Track: jumped to the WiFi fix (%.0f m off)", sqrtf(dx * dx + dy * dy)); put(fx, fy, R); }
        } else {
          float k = P / (P + R);
          px += k * dx;
          py += k * dy;
          P *= 1 - k;
          misses = 0;
        }
      }
    }
  }

  Lock l;
  shared.track.ok = have;
  shared.track.x = px;
  shared.track.y = py;
  shared.track.sigma = sqrtf(P);
  shared.track.floor = floor_;
  shared.track.steps = steps;
  shared.track.moving = moving;
}
