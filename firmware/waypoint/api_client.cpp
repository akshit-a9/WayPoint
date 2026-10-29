#include <HTTPClient.h>

#include "api_client.h"
#include "config.h"
#include "secrets.h"

bool apiIsReachable() {
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(String(API_BASE_URL) + "/health");
  int code = http.GET();
  http.end();
  return code == 200;
}

Location apiPredict(const JsonDocument &request) {
  Location result;

  String body;
  serializeJson(request, body);

  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.begin(String(API_BASE_URL) + "/predict");
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);  // negative = no connection, else the HTTP status
  String reply = code > 0 ? http.getString() : "";
  http.end();

  if (code < 0) {
    result.error = "Server unreachable";
    return result;
  }
  result.serverReached = true;

  if (code != 200) {
    result.error = "Server error " + String(code);
    return result;
  }

  JsonDocument doc;
  if (deserializeJson(doc, reply)) {
    result.error = "Bad reply from server";
    return result;
  }

  result.name = doc["location"].as<String>();
  result.confidence = doc["confidence"];
  result.knownAps = doc["known_aps"];
  result.totalAps = doc["total_aps"];

  // With no recognised APs the model's answer is a random guess.
  if (result.knownAps == 0) {
    result.error = "No known WiFi APs here";
    return result;
  }

  result.ok = true;
  return result;
}
