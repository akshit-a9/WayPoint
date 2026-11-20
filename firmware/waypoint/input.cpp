#include "input.h"

#include "config.h"

// Quadrature state-table decoder: only valid Gray-code transitions count, so
// contact bounce (up to ~1.5 ms on a KY-040) cancels itself out instead of
// adding phantom steps. The KY-040 does one full cycle (4 transitions) per detent.
static const int8_t QDEC[16] = {0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};

static volatile uint8_t encState = 0;
static volatile int16_t encQuarter = 0;
static int16_t usedDetents = 0;

static void IRAM_ATTR onEdge() {
  encState = ((encState << 2) | (digitalRead(PIN_ENC_CLK) << 1) | digitalRead(PIN_ENC_DT)) & 0x0f;
  encQuarter += QDEC[encState];
}

// Button
static bool rawDown = false, down = false, holdFired = false;
static uint32_t rawSince = 0, downSince = 0;

void inputInit() {
  pinMode(PIN_ENC_CLK, INPUT);   // module has its own pull-ups
  pinMode(PIN_ENC_DT, INPUT);
  pinMode(PIN_ENC_SW, INPUT_PULLUP);
  encState = (digitalRead(PIN_ENC_CLK) << 1) | digitalRead(PIN_ENC_DT);
  attachInterrupt(digitalPinToInterrupt(PIN_ENC_CLK), onEdge, CHANGE);
  attachInterrupt(digitalPinToInterrupt(PIN_ENC_DT), onEdge, CHANGE);
}

InputEvent inputPoll() {
  InputEvent e;
  uint32_t now = millis();

  // Button: debounce, then click on release or hold after HOLD_MS
  bool r = digitalRead(PIN_ENC_SW) == LOW;
  if (r != rawDown) { rawDown = r; rawSince = now; }
  if (rawDown != down && now - rawSince >= DEBOUNCE_MS) {
    down = rawDown;
    if (down) { downSince = now; holdFired = false; }
    else if (!holdFired) { e.type = IN_CLICK; return e; }
  }
  if (down && !holdFired && now - downSince >= HOLD_MS) {
    holdFired = true;
    e.type = IN_HOLD;
    return e;
  }

  // Encoder: whole detents only
  noInterrupts();
  int16_t q = encQuarter;
  interrupts();
  int16_t detents = q / 4 - usedDetents;
  if (detents) {
    usedDetents += detents;
    e.type = IN_TURN;
    e.steps = ENC_REVERSE ? -detents : detents;
  }
  return e;
}

float inputHoldProgress() {
  if (!down || holdFired) return 0;
  uint32_t held = millis() - downSince;
  return held < 120 ? 0 : min(1.0f, held / (float)HOLD_MS);   // don't flash the bar on a quick click
}
