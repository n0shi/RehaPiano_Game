// ==================== GYRO ROTATE DETECTOR ====================
// Detekcia Z-axis rotácie pre BTN_ROTATE akciu

import { imuExtractAxis } from './utils';

export class GyroRotateDetector {
  private enabled: boolean;
  private threshold: number;
  private cooldown: number;
  private alpha: number;
  private gzEma: number = 0.0;
  private lastFire: number = 0.0;
  private pending: boolean = false;

  constructor(
    enabled: boolean = true,
    thresholdDps: number = 450.0,
    cooldown: number = 0.45,
    emaAlpha: number = 0.2
  ) {
    this.enabled = enabled;
    this.threshold = thresholdDps;
    this.cooldown = cooldown;
    this.alpha = emaAlpha;
  }

  feed(imu: any): void {
    if (!this.enabled) return;

    const gz = imuExtractAxis(imu, 'z');
    if (gz === null) return;

    this.gzEma = (1.0 - this.alpha) * this.gzEma + this.alpha * gz;

    const now = Date.now() / 1000;
    if (
      Math.abs(this.gzEma) >= this.threshold &&
      now - this.lastFire >= this.cooldown
    ) {
      this.pending = true;
      this.lastFire = now;
    }
  }

  pop(): boolean {
    if (this.pending) {
      this.pending = false;
      return true;
    }
    return false;
  }
}
