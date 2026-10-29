#pragma once

#include <Arduino.h>

void displayInit();

// Title on the top line, then a message wrapped over the lines below.
void displayMessage(const char *title, const String &message);

// The result screen: location name, confidence and how many APs it recognised.
void displayLocation(const String &location, float confidence, int knownAps, int totalAps);
