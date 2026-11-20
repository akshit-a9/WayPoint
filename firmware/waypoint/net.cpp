#include "net.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <esp_core_dump.h>
#include <esp_mac.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_system.h>
#include <mbedtls/base64.h>

#include "config.h"
#include "leds.h"
#include "nav.h"
#include "secrets.h"
#include "state.h"
#include "telemetry.h"
#include "ui.h"

static char devId[18] = "";
static uint32_t bootId = 0;           // random per boot: the server starts a new session file
static bool newScan = false, newFix = false;
static bool wantUpdate = false;       // "update" from the Studio: fetch new firmware from the server

const char *deviceId() { return devId; }

static const char *resetReason() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power-on";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "crash";
    case ESP_RST_INT_WDT: case ESP_RST_TASK_WDT: case ESP_RST_WDT: return "watchdog";
    case ESP_RST_BROWNOUT: return "brownout";
    default: return "other";
  }
}

// Radio current: modem sleep wakes the radio in bursts and full transmit
// power makes big spikes; both dip the shared supply (the TFT backlight
// flickers). "radio sleep on|off" / "radio tx <dBm>" change them for testing.
static bool radioSleep = WIFI_SLEEP;
static int radioTxDbm = WIFI_TX_DBM;
static void applyRadio() {
  WiFi.setSleep(radioSleep);
  WiFi.setTxPower((wifi_power_t)(radioTxDbm * 4));   // wifi_power_t is in 0.25 dBm
  tlog("Radio: sleep %s, tx %d dBm", radioSleep ? "on" : "off", radioTxDbm);
}

static bool ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  { Lock l; shared.wifiUp = false; shared.serverUp = false; }
  statusLedSet(STATUS_CONNECTING_WIFI);
  apiLedSet(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) vTaskDelay(pdMS_TO_TICKS(250));
  if (WiFi.status() != WL_CONNECTED) return false;
  applyRadio();
  Lock l;
  shared.wifiUp = true;
  strlcpy(shared.ip, WiFi.localIP().toString().c_str(), sizeof shared.ip);
  tlog("WiFi up: %s, IP %s, ch %d", WIFI_SSID, shared.ip, WiFi.channel());
  return true;
}

static int post(const char *path, const String &body, String &reply, uint16_t *ms = nullptr) {
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(String(API_BASE_URL) + path);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", devId);
  uint32_t t0 = millis();
  int code = http.POST(body);
  if (ms) *ms = millis() - t0;
  if (code > 0) reply = http.getString();
  http.end();
  return code;
}

static void checkServer() {
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(String(API_BASE_URL) + "/health");
  int code = http.GET();
  bool ok = code == 200;
  if (ok) {
    JsonDocument doc;
    if (!deserializeJson(doc, http.getString())) { Lock l; strlcpy(shared.site, doc["site"] | "", sizeof shared.site); }
  }
  http.end();
  static int lastOk = -1;   // log only changes, not every 30 s check
  { Lock l; shared.serverUp = ok; }
  apiLedSet(ok);
  if (ok != lastOk) tlog("Server %s %s (HTTP %d)", API_BASE_URL, ok ? "reachable" : "NOT reachable", code);
  lastOk = ok;
}

// ---------------------------------------------------------------------------
// Scan + predict
// ---------------------------------------------------------------------------
// One scan over SCAN_CHANNELS (each channel is its own scan, so the results
// are gathered here), strongest first. Returns how many, or < 0 on failure.
#include <algorithm>
static Ap found[64];
static int scanChannels() {
  static const uint8_t chans[] = SCAN_CHANNELS;
  const int nChans = sizeof chans ? sizeof chans : 1;
  int n = 0;
  for (int c = 0; c < nChans; c++) {
    int got = WiFi.scanNetworks(false, true, false, SCAN_MS_PER_CHANNEL, sizeof chans ? chans[c] : 0);
    if (got < 0) return got;
    for (int i = 0; i < got && n < (int)(sizeof found / sizeof *found); i++) {
      Ap &a = found[n++];
      strlcpy(a.bssid, WiFi.BSSIDstr(i).c_str(), sizeof a.bssid);
      strlcpy(a.ssid, WiFi.SSID(i).c_str(), sizeof a.ssid);
      a.rssi = WiFi.RSSI(i);
      a.channel = WiFi.channel(i);
    }
    WiFi.scanDelete();
  }
  std::sort(found, found + n, [](const Ap &a, const Ap &b) { return a.rssi > b.rssi; });
  return n;
}

static void scanAndPredict() {
  statusLedSet(STATUS_SCANNING);
  uint32_t t0 = millis();
  int n = scanChannels();
  uint16_t dur = millis() - t0;
  if (n < 0) { tlog("WiFi scan failed (%d)", n); statusLedSet(STATUS_ERROR); return; }

  JsonDocument req;
  JsonArray scans = req["scans"].to<JsonArray>();
  {
    Lock l;
    shared.nAps = min(n, MAX_APS);
    memcpy(shared.aps, found, shared.nAps * sizeof *found);
    shared.scans++;
    shared.lastScanMs = dur;
  }
  for (int i = 0; i < n; i++) {
    JsonObject ap = scans.add<JsonObject>();
    ap["bssid"] = found[i].bssid;
    ap["rssi"] = found[i].rssi;
  }
  newScan = true;

  statusLedSet(STATUS_SCAN_SENT);
  String body, reply;
  serializeJson(req, body);
  uint16_t ms = 0;
  int code = post("/predict", body, reply, &ms);

  Fix f;
  f.at = millis();
  f.latencyMs = ms;
  JsonDocument res;
  if (code != 200) {
    snprintf(f.error, sizeof f.error, code > 0 ? "Server error %d" : "Server unreachable", code);
  } else if (deserializeJson(res, reply)) {
    strlcpy(f.error, "Bad reply", sizeof f.error);
  } else {
    f.ok = true;
    strlcpy(f.location, res["location"] | "?", sizeof f.location);
    strlcpy(f.spot, res["spot"] | "", sizeof f.spot);
    f.confidence = res["confidence"] | 0.0f;
    f.knownAps = res["known_aps"] | 0;
    f.totalAps = res["total_aps"] | 0;
    if (res["xy"].is<JsonArray>()) { f.hasXy = true; f.x = res["xy"][0]; f.y = res["xy"][1]; }
    for (JsonObject t : res["top"].as<JsonArray>()) {
      if (f.nTop >= MAX_TOP) break;
      strlcpy(f.topSpot[f.nTop], t["spot"] | "", sizeof f.topSpot[0]);
      f.topP[f.nTop++] = t["p"] | 0.0f;
    }
  }
  bool reached = code > 0;
  apiLedSet(reached);
  statusLedSet(f.ok ? STATUS_RESPONSE_RECEIVED : STATUS_ERROR);
  Lock l;
  shared.fix = f;
  shared.serverUp = reached;
  newFix = true;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------
static void runCommand(JsonObject c) {
  const char *cmd = c["cmd"] | "";
  const char *arg = c["arg"] | "";
  tlog("Command from Studio: %s %s", cmd, arg);
#if PRODUCTION
  return;   // production builds don't take orders over the network
#endif
  if (!strcmp(cmd, "reboot")) { vTaskDelay(pdMS_TO_TICKS(200)); ESP.restart(); }
  // "update": download the firmware the server holds (firmware/flash-wifi.ps1 builds it) and reboot into it
  if (!strcmp(cmd, "update")) { wantUpdate = true; return; }
  // "radio sleep on|off", "radio tx <dBm 2..20>": WiFi current spikes (screen flicker test)
  if (!strcmp(cmd, "radio")) {
    if (!strncmp(arg, "sleep ", 6)) radioSleep = !strcmp(arg + 6, "on");
    else if (!strncmp(arg, "tx ", 3)) radioTxDbm = constrain(atoi(arg + 3), 2, 20);
    applyRadio();
    return;
  }
  Lock l;
  if (!strcmp(cmd, "level")) shared.telemetryLevel = constrain(atoi(arg), 0, 2);
  else if (!strcmp(cmd, "i2cscan")) shared.wantI2cScan = true;
  else if (!strcmp(cmd, "toast")) { strlcpy(shared.toast, arg, sizeof shared.toast); shared.toastUntil = millis() + 3000; }
  // Navigation: "nav <spot id>" / "nav stop"; for testing: "at <spot id>|off", "hdg <deg>|off"
  else if (!strcmp(cmd, "nav")) strlcpy(shared.navCmd, arg, sizeof shared.navCmd);
  else if (!strcmp(cmd, "at")) strlcpy(shared.fakeAt, strcmp(arg, "off") ? arg : "", sizeof shared.fakeAt);
  else if (!strcmp(cmd, "hdg")) shared.fakeHdg = strcmp(arg, "off") && arg[0] ? fmodf(atof(arg) + 360, 360) : NAN;
  // "screen <s>": send the screen picture with each batch for s seconds
  else if (!strcmp(cmd, "screen")) shared.screenUntil = millis() + constrain(atoi(arg), 1, 120) * 1000;
  // "knob off|on": ignore the real knob (no encoder wired: its input pins float and fake turns)
  else if (!strcmp(cmd, "knob") && (!strcmp(arg, "off") || !strcmp(arg, "on"))) shared.knobOff = !strcmp(arg, "off");
  // "knob <n>|click|hold": as if the knob were turned n detents, clicked or held
  else if (!strcmp(cmd, "knob") && shared.nKnob < sizeof shared.knob) {
    shared.knob[shared.nKnob++] = !strcmp(arg, "click") ? KNOB_CLICK : !strcmp(arg, "hold") ? KNOB_HOLD : constrain(atoi(arg), -20, 20);
  }
  // "flip on|off": screen upside down (saved on the device)
  else if (!strcmp(cmd, "flip")) shared.wantFlip = !strcmp(arg, "on") ? 1 : 0;
  // "theme light|dark": screen colours (saved on the device)
  else if (!strcmp(cmd, "theme")) shared.wantTheme = !strcmp(arg, "light") ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Navigation pack: fetched again whenever the telemetry reply names a new version
// ---------------------------------------------------------------------------
static void fetchNavPack(const char *want) {
  static uint32_t lastTry = 0;
  if (lastTry && millis() - lastTry < 10000) return;   // don't hammer a failing server
  lastTry = millis();
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(String(API_BASE_URL) + "/api/device/nav");
  http.addHeader("X-Device-Id", devId);
  int code = http.GET();
  if (code == 200 && navLoad(http.getString())) lastTry = 0;
  else if (code != 200) tlog("Nav pack %s: HTTP %d", want, code);
  http.end();
}

// The reply's "take" drives the recording screen. The device keeps its own
// clock from the server's elapsed time, so the countdown runs smoothly between
// the once-a-second replies.
static void applyTake(JsonVariant t) {
  Lock l;
  Take &k = shared.take;
  if (t.isNull()) { k.active = false; return; }
  uint32_t start = millis() - (uint32_t)((t["elapsed"] | 0.0f) * 1000);
  if (!k.active || abs((int32_t)(start - k.startMs)) > 800) k.startMs = start;
  if (!k.active) tlog("Take started: %s", (const char *)(t["spot"] | ""));
  k.active = true;
  k.done = t["done"] | false;
  strlcpy(k.spot, t["spot"] | "", sizeof k.spot);
  k.seconds = t["seconds"] | 90;
  k.turnEvery = t["turnEvery"] | 11.25f;
  k.scans = t["scans"] | 0;
  k.seenMs = millis();
}

static void sendTelemetry() {
  uint8_t level;
  { Lock l; level = shared.telemetryLevel; }

  JsonDocument doc;
  doc["device"] = devId;
  doc["boot"] = bootId;
  doc["fw"] = FW_VERSION;
  doc["t"] = millis();
  if (level > 0) {
    Lock l;
    JsonObject h = doc["health"].to<JsonObject>();
    h["uptime"] = millis() / 1000;
    h["heap"] = ESP.getFreeHeap();
    h["minHeap"] = ESP.getMinFreeHeap();
    h["rssi"] = WiFi.RSSI();
    h["ch"] = WiFi.channel();
    h["fps"] = shared.fps;
    h["scans"] = shared.scans;
    h["scanMs"] = shared.lastScanMs;
    h["i2cErr"] = shared.i2cErrors;
    h["mag"] = shared.magOk;
    h["mpu"] = shared.mpuOk;
    h["oled"] = shared.oledOk;
    h["reset"] = resetReason();
    static String md5 = ESP.getSketchMD5();   // which build is running (flash-wifi.ps1 checks it)
    h["md5"] = md5;
    h["sent"] = shared.telemetrySent;
    h["failed"] = shared.telemetryFailed;
    h["level"] = level;
    JsonObject ui = doc["ui"].to<JsonObject>();
    ui["screen"] = shared.screen;
    ui["sel"] = shared.sel;

    if (newScan) {
      JsonObject s = doc["scan"].to<JsonObject>();
      s["ms"] = shared.lastScanMs;
      JsonArray aps = s["aps"].to<JsonArray>();   // [bssid, rssi, channel, ssid]
      for (int i = 0; i < shared.nAps; i++) {
        JsonArray a = aps.add<JsonArray>();
        a.add(shared.aps[i].bssid); a.add(shared.aps[i].rssi); a.add(shared.aps[i].channel); a.add(shared.aps[i].ssid);
      }
      newScan = false;
    }
    if (newFix) {
      const Fix &f = shared.fix;
      JsonObject p = doc["pred"].to<JsonObject>();
      p["ok"] = f.ok;
      p["location"] = f.location;
      p["spot"] = f.spot;
      p["conf"] = f.confidence;
      p["known"] = f.knownAps;
      p["total"] = f.totalAps;
      p["ms"] = f.latencyMs;
      if (f.hasXy) { JsonArray xy = p["xy"].to<JsonArray>(); xy.add(f.x); xy.add(f.y); }
      if (f.error[0]) p["error"] = f.error;
      newFix = false;
    }
    // Navigation, for the Studio's Live tab
    JsonObject n = doc["nav"].to<JsonObject>();
    char v[12];
    navVersion(v, sizeof v);
    n["v"] = v;
    n["n"] = navCount();
    n["dest"] = shared.nav.dest;
    n["at"] = shared.nav.dest[0] ? shared.nav.at : "";
    n["next"] = shared.nav.next;
    n["dist"] = roundf(shared.nav.dist * 10) / 10;
    n["brg"] = roundf(shared.nav.brg);
    if (!isnan(shared.nav.hdg)) n["hdg"] = roundf(shared.nav.hdg); else n["hdg"] = nullptr;
    n["arrived"] = shared.nav.arrived;
    n["cue"] = shared.nav.cue;
    n["fakeAt"] = shared.fakeAt;
    if (!isnan(shared.fakeHdg)) n["fakeHdg"] = roundf(shared.fakeHdg); else n["fakeHdg"] = nullptr;
    n["knobOff"] = shared.knobOff;
    // Smoothed position (steps + WiFi), for the Live map's trail
    JsonObject tr = doc["track"].to<JsonObject>();
    if (shared.track.ok) {
      tr["x"] = roundf(shared.track.x * 100) / 100;
      tr["y"] = roundf(shared.track.y * 100) / 100;
      tr["s"] = roundf(shared.track.sigma * 10) / 10;
      tr["f"] = shared.track.floor;
    }
    tr["steps"] = shared.track.steps;
    tr["moving"] = shared.track.moving;
  }
  // The screen picture, while the Studio shows it (base64 of the run-length coded
  // frame). On the heap: static RAM is full.
  static const size_t SCR_MAX = 8192, B64_MAX = 11000;
  static uint8_t *scr = (uint8_t *)malloc(SCR_MAX);
  static unsigned char *b64 = (unsigned char *)malloc(B64_MAX);
  size_t b64len = 0, n;
  ScreenInfo si;
  if (scr && b64 && (n = uiScreen(scr, SCR_MAX, &si)) && mbedtls_base64_encode(b64, B64_MAX, &b64len, scr, n) == 0) {
    doc["scr"] = (const char *)b64;
    doc["scrf"] = si.format;   // "1bpp" (OLED pages) or "rle332" ([count, colour] pairs)
    doc["scrw"] = si.w;
    doc["scrh"] = si.h;
  }
  if (level >= 2) telemetryDrain(doc);   // logs, UI events, 10 Hz sensor samples

  String body, reply;
  serializeJson(doc, body);
  int code = post("/api/device/telemetry", body, reply);
  { Lock l; if (code == 200) shared.telemetrySent++; else shared.telemetryFailed++; }
  if (code != 200) return;
  // A new image from a WiFi update is on trial: the bootloader rolls it back at
  // the next reset unless it is marked good. Reaching the server is good enough.
  static bool markedGood = false;
  if (!markedGood) {
    markedGood = true;
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
      esp_ota_mark_app_valid_cancel_rollback();
      tlog("Firmware update kept (server reached)");
    }
  }
  JsonDocument res;
  if (deserializeJson(res, reply)) return;
  applyTake(res["take"]);
  if (uint32_t clock = res["clock"] | 0) { Lock l; shared.clock = clock; shared.clockAt = millis(); }
  const char *want = res["nav"] | "";
  char have[12];
  navVersion(have, sizeof have);
  if (want[0] && strcmp(want, have)) fetchNavPack(want);
  if (res["live"] | false) {
    bool was = isLive();
    { Lock l; shared.liveUntil = millis() + LIVE_HOLD_MS; }
    if (!was) tlog("Live sensor stream on (Studio watching)");
  }
  for (JsonObject c : res["commands"].as<JsonArray>()) runCommand(c);
}

// ---------------------------------------------------------------------------
// Live sensor stream: one small UDP packet per LIVE_MS while the Studio watches
// ---------------------------------------------------------------------------
bool isLive() {
  Lock l;
  return (int32_t)(shared.liveUntil - millis()) > 0;
}

static void liveTask(void *) {
  // Server host from API_BASE_URL ("http://host:port"); same machine, UDP port
  char host[64];
  const char *h = strstr(API_BASE_URL, "://");
  strlcpy(host, h ? h + 3 : API_BASE_URL, sizeof host);
  host[strcspn(host, ":/")] = 0;

  WiFiUDP udp;
  bool was = false;
  uint32_t sent = 0;
  for (;;) {
    bool live = isLive() && WiFi.status() == WL_CONNECTED;
    if (was && !live) tlog("Live sensor stream off (%lu packets)", (unsigned long)sent);
    was = live;
    if (!live) { sent = 0; vTaskDelay(pdMS_TO_TICKS(200)); continue; }

    int16_t m[3], a[3];
    { Lock l; memcpy(m, shared.mag, sizeof m); memcpy(a, shared.acc, sizeof a); }
    char pkt[112];
    int n = snprintf(pkt, sizeof pkt, "{\"d\":\"%s\",\"t\":%lu,\"s\":[%d,%d,%d,%d,%d,%d]}", devId,
                     (unsigned long)millis(), m[0], m[1], m[2], a[0], a[1], a[2]);
    if (udp.beginPacket(host, LIVE_UDP_PORT)) { udp.write((const uint8_t *)pkt, n); if (udp.endPacket()) sent++; }
    vTaskDelay(pdMS_TO_TICKS(LIVE_MS));
  }
}

// ---------------------------------------------------------------------------
// Firmware over WiFi: fetch GET /api/device/firmware into the spare app
// partition, then reboot into it. A failed or cut-off download leaves the
// running firmware as it was.
static void toastNow(const char *msg, uint32_t ms) {
  Lock l;
  strlcpy(shared.toast, msg, sizeof shared.toast);
  shared.toastUntil = millis() + ms;
}

static void firmwareUpdate() {
  tlog("Firmware update: downloading from the server");
  toastNow("Updating...", 60000);
  WiFiClient client;
  httpUpdate.rebootOnUpdate(false);
  httpUpdate.onProgress([](int done, int total) {
    static int last = -1;
    int pct = total > 0 ? done * 100 / total : 0;
    if (pct / 10 == last) return;
    last = pct / 10;
    char msg[22];
    snprintf(msg, sizeof msg, "Updating %d%%", pct);
    toastNow(msg, 60000);
  });
  HTTPUpdateResult r = httpUpdate.update(client, String(API_BASE_URL) + "/api/device/firmware");
  if (r == HTTP_UPDATE_OK) {
    tlog("Firmware update: done, rebooting");
    toastNow("Updated, rebooting", 3000);
    sendTelemetry();
    vTaskDelay(pdMS_TO_TICKS(500));
    ESP.restart();
  }
  tlog("Firmware update failed: %s", httpUpdate.getLastErrorString().c_str());
  toastNow("Update failed", 3000);
}

// The core dump the panic handler left in flash, sent whole to the server so
// every task's backtrace can be read with gdb (the summary alone often isn't
// enough). Erased once the server has it.
static void uploadCoreDump() {
  size_t addr = 0, size = 0;
  if (esp_core_dump_image_get(&addr, &size) != ESP_OK || !size || size > 65536) return;
  const esp_partition_t *p = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_COREDUMP, nullptr);
  uint8_t *buf = (uint8_t *)malloc(size);
  if (p && buf && esp_partition_read(p, addr - p->address, buf, size) == ESP_OK) {
    HTTPClient http;
    http.setTimeout(10000);
    http.begin(String(API_BASE_URL) + "/api/device/coredump");
    http.addHeader("Content-Type", "application/octet-stream");
    http.addHeader("X-Device-Id", devId);
    int code = http.POST(buf, size);
    http.end();
    tlog("Crash dump sent to the server (%u bytes, HTTP %d)", (unsigned)size, code);
    if (code == 200) esp_core_dump_image_erase();
  }
  free(buf);
}

static void netTask(void *) {
  uint32_t lastTelemetry = 0, lastScan = 0, lastHealth = 0;
  bool dumpChecked = false;
  for (;;) {
    if (!ensureWifi()) { vTaskDelay(pdMS_TO_TICKS(2000)); continue; }
    uint32_t now = millis();
    { Lock l; shared.wifiRssi = WiFi.RSSI(); shared.wifiChannel = WiFi.channel(); }
    if (wantUpdate) { wantUpdate = false; firmwareUpdate(); }
    if (now - lastHealth > 30000 || !lastHealth) { checkServer(); lastHealth = now; }
    if (!dumpChecked) { bool up; { Lock l; up = shared.serverUp; } if (up) { dumpChecked = true; uploadCoreDump(); } }
    if (now - lastTelemetry >= TELEMETRY_MS) { lastTelemetry = now; sendTelemetry(); }
    // A scan holds the radio for ~2 s; skip it while live, unless a take needs it
    bool recording;
    { Lock l; recording = shared.take.active; }
    if (now - lastScan >= SCAN_INTERVAL_MS && (recording || !isLive())) { scanAndPredict(); lastScan = millis(); sendTelemetry(); lastTelemetry = millis(); }
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

void netStart() {
  WiFi.mode(WIFI_STA);
  // WiFi.macAddress() reads zeros until the driver has started; ask the eFuse instead
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(devId, sizeof devId, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  bootId = esp_random() & 0x7fffffff;
  tlog("WayPoint %s, device %s, reset: %s", FW_VERSION, devId, resetReason());
  xTaskCreatePinnedToCore(netTask, "net", 12288, nullptr, 1, nullptr, 0);
  xTaskCreatePinnedToCore(liveTask, "live", 4096, nullptr, 2, nullptr, 0);
}
