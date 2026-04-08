export type Landmark = { x: number; y: number; z: number }
export type HandLandmarks = Landmark[]

export function computeHandTilt(lms: HandLandmarks) {
  // Reference points: wrist (0), index MCP (5), pinky MCP (17)
  const wrist = lms[0]
  const indexMcp = lms[5]
  const pinkyMcp = lms[17]
  if (!wrist || !indexMcp || !pinkyMcp) return { xDeg: 0, yDeg: 0 }

  const v1 = sub(indexMcp, wrist)
  const v2 = sub(pinkyMcp, wrist)
  const n = normalize(cross(v1, v2)) // palm normal

  // Map normal to pitch/yaw-ish values (empirical but works well)
  // n.y ~ up/down tilt; n.x ~ left/right twist depending on camera mirroring.
  const pitch = Math.asin(clamp(-n.y, -1, 1)) // forward/back
  const yaw = Math.asin(clamp(n.x, -1, 1)) // side tilt

  return {
    xDeg: rad2deg(pitch) * 35,
    yDeg: rad2deg(yaw) * 40,
  }
}

export function computePinch(lms: HandLandmarks) {
  const thumbTip = lms[4]
  const indexTip = lms[8]
  const wrist = lms[0]
  const midMcp = lms[9]
  if (!thumbTip || !indexTip || !wrist || !midMcp) return 0

  const pinchDist = dist(thumbTip, indexTip)
  const handScale = Math.max(1e-6, dist(wrist, midMcp))

  // Normalize and convert to a 0..1-ish control: smaller distance => bigger "pinch" value
  const normalized = pinchDist / handScale
  const v = 1 - (normalized - 0.25) / (0.95 - 0.25)
  return clamp(v, 0, 1)
}

export function countExtendedFingers(lms: HandLandmarks) {
  // Heuristic: a finger is "extended" if TIP is above PIP in image space (y smaller),
  // with a little margin. Works well for front-facing webcam.
  const thumb = isThumbExtended(lms)
  const index = isFingerExtended(lms, 8, 6)
  const middle = isFingerExtended(lms, 12, 10)
  const ring = isFingerExtended(lms, 16, 14)
  const pinky = isFingerExtended(lms, 20, 18)
  return (thumb ? 1 : 0) + (index ? 1 : 0) + (middle ? 1 : 0) + (ring ? 1 : 0) + (pinky ? 1 : 0)
}

function sub(a: Landmark, b: Landmark) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function cross(a: Landmark, b: Landmark) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

function normalize(v: Landmark) {
  const len = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

function dist(a: Landmark, b: Landmark) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

function rad2deg(r: number) {
  return (r * 180) / Math.PI
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

function isFingerExtended(lms: HandLandmarks, tip: number, pip: number) {
  const t = lms[tip]
  const p = lms[pip]
  if (!t || !p) return false
  return t.y < p.y - 0.02
}

function isThumbExtended(lms: HandLandmarks) {
  // Thumb is sideways; use x-distance between tip and IP relative to hand size.
  const tip = lms[4]
  const ip = lms[3]
  const indexMcp = lms[5]
  const pinkyMcp = lms[17]
  if (!tip || !ip || !indexMcp || !pinkyMcp) return false
  const span = Math.abs(indexMcp.x - pinkyMcp.x) || 1e-6
  const dx = Math.abs(tip.x - ip.x)
  return dx / span > 0.22
}

