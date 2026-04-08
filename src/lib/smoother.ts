export class ExpSmoother {
  private y: number | null = null
  constructor(private readonly alpha: number) {}

  next(x: number) {
    if (this.y === null || !Number.isFinite(this.y)) {
      this.y = x
      return x
    }
    const a = clamp(this.alpha, 0, 1)
    this.y = this.y + (x - this.y) * a
    return this.y
  }

  reset() {
    this.y = null
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

