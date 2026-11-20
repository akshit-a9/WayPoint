#include "telemetry.h"

#include <stdarg.h>

#define LOG_N 32
#define EVENT_N 48
#define SAMPLE_N 40   // 4 s of 10 Hz samples, in case a POST is slow

struct LogLine { uint32_t t; char text[96]; };
struct Event { uint32_t t; char type[12]; int value; char text[24]; };
struct Sample { uint32_t t; int16_t mag[3], acc[3]; };

static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static LogLine logs[LOG_N];
static Event events[EVENT_N];
static Sample samples[SAMPLE_N];
static int nLog = 0, nEvent = 0, nSample = 0;
static uint32_t droppedLog = 0, droppedEvent = 0, droppedSample = 0;

void telemetryInit() {}

void tlog(const char *fmt, ...) {
  LogLine l;
  l.t = millis();
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(l.text, sizeof l.text, fmt, ap);
  va_end(ap);
  Serial.println(l.text);
  portENTER_CRITICAL(&mux);
  if (nLog < LOG_N) logs[nLog++] = l; else droppedLog++;
  portEXIT_CRITICAL(&mux);
}

void tevent(const char *type, int value, const char *text) {
  Event e;
  e.t = millis();
  strlcpy(e.type, type, sizeof e.type);
  e.value = value;
  strlcpy(e.text, text ? text : "", sizeof e.text);
  portENTER_CRITICAL(&mux);
  if (nEvent < EVENT_N) events[nEvent++] = e; else droppedEvent++;
  portEXIT_CRITICAL(&mux);
}

void tsample(const int16_t mag[3], const int16_t acc[3]) {
  Sample s;
  s.t = millis();
  memcpy(s.mag, mag, sizeof s.mag);
  memcpy(s.acc, acc, sizeof s.acc);
  portENTER_CRITICAL(&mux);
  if (nSample < SAMPLE_N) samples[nSample++] = s; else droppedSample++;
  portEXIT_CRITICAL(&mux);
}

void telemetryDrain(JsonDocument &out) {
  // Copy out under the lock, build JSON outside it
  static LogLine L[LOG_N];
  static Event E[EVENT_N];
  static Sample S[SAMPLE_N];
  int nl, ne, ns;
  uint32_t dl, de, ds;
  portENTER_CRITICAL(&mux);
  nl = nLog; ne = nEvent; ns = nSample;
  memcpy(L, logs, nl * sizeof *L); memcpy(E, events, ne * sizeof *E); memcpy(S, samples, ns * sizeof *S);
  dl = droppedLog; de = droppedEvent; ds = droppedSample;
  nLog = nEvent = nSample = 0;
  droppedLog = droppedEvent = droppedSample = 0;
  portEXIT_CRITICAL(&mux);

  JsonArray la = out["log"].to<JsonArray>();
  for (int i = 0; i < nl; i++) { JsonArray r = la.add<JsonArray>(); r.add(L[i].t); r.add(L[i].text); }
  JsonArray ea = out["events"].to<JsonArray>();
  for (int i = 0; i < ne; i++) { JsonArray r = ea.add<JsonArray>(); r.add(E[i].t); r.add(E[i].type); r.add(E[i].value); r.add(E[i].text); }
  // [t, magX, magY, magZ, accX, accY, accZ]
  JsonArray sa = out["sensors"].to<JsonArray>();
  for (int i = 0; i < ns; i++) {
    JsonArray r = sa.add<JsonArray>();
    r.add(S[i].t);
    for (int k = 0; k < 3; k++) r.add(S[i].mag[k]);
    for (int k = 0; k < 3; k++) r.add(S[i].acc[k]);
  }
  if (dl || de || ds) {
    JsonObject d = out["dropped"].to<JsonObject>();
    d["log"] = dl; d["events"] = de; d["sensors"] = ds;
  }
}
