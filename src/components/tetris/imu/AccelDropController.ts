// ==================== ACCEL DROP CONTROLLER ====================
// Detekcia pitch pre soft/hard drop

import { imuExtractVector } from './utils';

export const BTN_DOWN = 'DOWN';
export const BTN_DROP = 'DROP';

export class AccelDropController {
  private enabled: boolean;
  private softThreshold: number;
  private hardThreshold: number;
  private alpha: number;
  private baseInterval: number;
  private minInterval: number;
  private gain: number;
  private hysteresis: number;
  private holdTime: number;
  public armThreshold: number; // Public to allow access from SettingsMenu
  public armed: boolean = false; // Public to allow access from SettingsMenu

  private pitchEma: number = 0.0;
  private lastDown: number = 0.0;
  private hardSince: number | null = null;
  private pending: string[] = [];

  constructor(
    config: {
      enabled?: boolean;
      softThreshold?: number;
      hardThreshold?: number;
      alpha?: number;
      baseInterval?: number;
      minInterval?: number;
      gain?: number;
      hysteresis?: number;
      holdTime?: number;
      armThreshold?: number;
    } = {}
  ) {
    this.enabled = config.enabled ?? true;
    this.softThreshold = config.softThreshold ?? -30.0;
    this.hardThreshold = config.hardThreshold ?? -58.0;
    this.alpha = config.alpha ?? 0.18;
    this.baseInterval = config.baseInterval ?? 0.34;
    this.minInterval = config.minInterval ?? 0.12;
    this.gain = config.gain ?? 0.0022;
    this.hysteresis = config.hysteresis ?? 0;
    this.holdTime = config.holdTime ?? 0.05;
    this.armThreshold = config.armThreshold ?? 15.0;
  }

  private computePitch(imu: any): number | null {
    // Try direct pitch
    if (typeof imu === 'object' && 'pitch' in imu) {
      try {
        return parseFloat(imu.pitch) / 16.0;
      } catch {
        // continue
      }
    }

    // Try euler vector
    const euler = imuExtractVector(imu, 'euler');
    if (euler !== null) return euler[1];

    // Compute from gravity
    if (typeof imu === 'object') {
      const gx = imu.gravX;
      const gy = imu.gravY;
      const gz = imu.gravZ;

      if (
        gx !== null &&
        gx !== undefined &&
        gy !== null &&
        gy !== undefined &&
        gz !== null &&
        gz !== undefined
      ) {
        try {
          const gxf = parseFloat(gx) / 100.0;
          const gyf = parseFloat(gy) / 100.0;
          const gzf = parseFloat(gz) / 100.0;
          return (
            Math.atan2(-gxf, Math.sqrt(gyf * gyf + gzf * gzf)) * (180 / Math.PI)
          );
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  feed(imu: any): void {
    if (!this.enabled) return;

    const pitch = this.computePitch(imu);
    if (pitch === null) return;

    this.pitchEma = (1 - this.alpha) * this.pitchEma + this.alpha * pitch;

    const now = Date.now() / 1000;

    // Debug log - loguj pitch každých cca 60 framov (1 sekunda)
    if (Math.random() < 0.02) {
      console.log(`[DROP DEBUG] Pitch: ${this.pitchEma.toFixed(1)} (HardThr: ${this.hardThreshold})`);
    }

    // Soft drop (repeated BTN_DOWN)
    if (this.pitchEma <= this.softThreshold) {
      const over = Math.abs(this.pitchEma - this.softThreshold);
      const interval = Math.max(
        this.minInterval,
        this.baseInterval - this.gain * over * 10.0
      );

      if (now - this.lastDown >= interval) {
        this.lastDown = now;
        this.pending.push(BTN_DOWN);
      }
    }

    // Arming logic (Tilt UP to arm)
    if (this.pitchEma >= this.armThreshold) {
      if (!this.armed) {
        this.armed = true;
        console.log(`[DROP] ARMED! Pitch: ${this.pitchEma.toFixed(1)} >= ${this.armThreshold}`);
      }
    }

    // Hard drop (single BTN_DROP after hold time) - ONLY IF ARMED
    if (this.pitchEma <= this.hardThreshold - this.hysteresis) {
      if (this.armed) {
        if (this.hardSince === null) {
          this.hardSince = now;
          console.log(`[DROP] HARD DROP PENDING... Pitch: ${this.pitchEma.toFixed(1)} <= ${this.hardThreshold}`);
        } else if (now - this.hardSince >= this.holdTime) {
          this.pending.push(BTN_DROP);
          console.log('[DROP] HARD DROP FIRED!');
          this.hardSince = null;
          this.armed = false; // Disarm after drop
        }
      }
    } else {
      this.hardSince = null;
    }
  }

  popAll(): string[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}
