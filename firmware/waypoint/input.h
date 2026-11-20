#pragma once

// KY-040 rotary encoder with its push button: the device's only input.
//   turn   one event per detent (+1 clockwise, -1 counter-clockwise)
//   click  released before HOLD_MS
//   hold   fires as soon as the button has been down HOLD_MS (no need to release)

#include <Arduino.h>

enum InputType { IN_NONE, IN_TURN, IN_CLICK, IN_HOLD };

struct InputEvent {
  InputType type = IN_NONE;
  int steps = 0;   // IN_TURN: detents since the last poll (sign = direction)
};

void inputInit();

// Call every loop. Returns at most one event; call again until IN_NONE.
InputEvent inputPoll();

// 0..1 while the button is down and a hold is building up (for the hold bar)
float inputHoldProgress();
