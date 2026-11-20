// QMC5883P magnetometer as mounted on the breadboard: the board stands
// upright, so the horizontal field shows up on its X and Z axes, not X and Y.
//
// Real sensors read  m = S·(true field) + offset  where `offset` is hard-iron
// (magnetised steel, the ESP32's regulator, wiring currents) and S stretches
// the circle into an ellipse (soft iron). Calibration: turn the device through
// a full circle, track min/max on each axis, then
//   offset = (max + min) / 2,   scale = mean radius / ((max - min) / 2)
// which turns the ellipse back into a centred circle. The firmware does exactly this.

export interface Distortion { offX: number; offZ: number; scaleX: number; scaleZ: number; noise: number }
export interface Calibration { offX: number; offZ: number; scaleX: number; scaleZ: number }
export const IDENTITY: Calibration = { offX: 0, offZ: 0, scaleX: 1, scaleZ: 1 }

const FIELD = 40 // µT, horizontal component of the earth's field in Goa (~40 µT)
const rad = (d: number) => (d * Math.PI) / 180
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())

/** Raw X/Z reading in µT for a device facing `heading` degrees. */
export function read(heading: number, d: Distortion): [number, number] {
  const x = FIELD * Math.cos(rad(heading)), z = -FIELD * Math.sin(rad(heading))
  return [x * d.scaleX + d.offX + gauss() * d.noise, z * d.scaleZ + d.offZ + gauss() * d.noise]
}

/** Heading in degrees clockwise from magnetic north. */
export function heading([x, z]: [number, number], c: Calibration): number {
  const cx = (x - c.offX) * c.scaleX, cz = (z - c.offZ) * c.scaleZ
  return ((Math.atan2(-cz, cx) * 180) / Math.PI + 360) % 360
}

/** Running min/max collector used while the user turns the device around. */
export class Calibrator {
  minX = Infinity; maxX = -Infinity; minZ = Infinity; maxZ = -Infinity
  covered = new Uint8Array(36) // 10° sectors seen, for the progress ring
  add([x, z]: [number, number], approxHeading: number) {
    this.minX = Math.min(this.minX, x); this.maxX = Math.max(this.maxX, x)
    this.minZ = Math.min(this.minZ, z); this.maxZ = Math.max(this.maxZ, z)
    this.covered[Math.floor(((approxHeading % 360) + 360) % 360 / 10)] = 1
  }
  progress() { return this.covered.reduce((a, b) => a + b, 0) / 36 }
  result(): Calibration {
    const rx = (this.maxX - this.minX) / 2, rz = (this.maxZ - this.minZ) / 2, r = (rx + rz) / 2
    return { offX: (this.maxX + this.minX) / 2, offZ: (this.maxZ + this.minZ) / 2, scaleX: r / rx, scaleZ: r / rz }
  }
}
