// ==================== IMU SPACE POINTER ====================
// Integruje akceleráciu do pozície s anti-shake, auto-ZUPT a velocity leak

import {
  qFromIMU,
  qConjugate,
  qMultiply,
  qRotateVector,
  qToEuler,
  type Quaternion,
  type Vec3,
} from './quaternion';

export class IMUSpacePointer {
  // EMA & filtering
  public alpha: number;
  public deadzone: number;
  public leak: number;
  public satAcc: number;
  public satVel: number;
  public scaleX: number;
  public scaleY: number;
  public hysteresis: number;

  // Orientation baseline
  public oriEnable: boolean = true;
  public oriEma: number = 0.2;
  public oriDead: number = 1.5;
  public oriGainX: number = 0.04;
  public oriGainY: number = 0.04;
  public oriMax: number = 30.0;
  private oriFx: number = 0.0;
  private oriFy: number = 0.0;
  private ox: number = 0.0;
  private oy: number = 0.0;

  // State
  public q0: Quaternion | null = null;
  public af: Vec3 = [0, 0, 0];
  public v: Vec3 = [0, 0, 0];
  public p: Vec3 = [0, 0, 0];
  public lastEmitCol: number | null = null;
  public lastEmitRow: number | null = null;

  enabled: boolean = true;

  // Source config
  public source: 'linacc' | 'accminusgrav' | 'gravdelta' = 'linacc';
  public linaccScale: number = 0.1019368;
  private prevG: Vec3 | null = null;

  // Anti-shake / Auto-ZUPT
  public shakeAccThreshold: number = 3.0;
  public shakeHold: number = 0.2;
  private shakeUntil: number = 0.0;
  public quietA: number = 0.03;
  public zuptTime: number = 0.12;
  private quietT: number = 0.0;
  public pSpring: number = 0.35;
  public satPos: number = 2.0;

  constructor(
    config: {
      emaAlpha?: number;
      deadzoneA?: number;
      leak?: number;
      satAcc?: number;
      satVel?: number;
      scaleX?: number;
      scaleY?: number;
      hysteresis?: number;
    } = {}
  ) {
    this.alpha = config.emaAlpha ?? 0.15;
    this.deadzone = config.deadzoneA ?? 0.03;
    this.leak = config.leak ?? 0.18;
    this.satAcc = config.satAcc ?? 2.5;
    this.satVel = config.satVel ?? 1.5;
    this.scaleX = config.scaleX ?? 0.6;
    this.scaleY = config.scaleY ?? 0.6;
    this.hysteresis = config.hysteresis ?? 0.55;
  }

  calibrateZero(imu: any): void {
    const q = qFromIMU(imu);
    if (q !== null) {
      this.q0 = q;
    }
    this.af = [0, 0, 0];
    this.v = [0, 0, 0];
    this.p = [0, 0, 0];
    this.lastEmitCol = null;
    this.lastEmitRow = null;
    this.shakeUntil = 0;
    this.quietT = 0;
  }

  feed(imu: any, dt: number, stationary: boolean = false): void {
    if (!this.enabled || dt <= 0) return;

    // 0) Quaternions
    const q = qFromIMU(imu);
    if (q === null || this.q0 === null) return;

    const qrel = qMultiply(qConjugate(this.q0), q);

    // 1) Orientation baseline (roll/pitch) - skip during shake
    const now = Date.now() / 1000;
    let inShake = now < this.shakeUntil;

    if (this.oriEnable && !inShake) {
      const euler = qToEuler(qrel);
      let roll = Math.max(-this.oriMax, Math.min(this.oriMax, euler.roll));
      let pitch = Math.max(-this.oriMax, Math.min(this.oriMax, euler.pitch));

      const a = this.oriEma;
      this.oriFx = (1 - a) * this.oriFx + a * roll;
      this.oriFy = (1 - a) * this.oriFy + a * pitch;

      const dz = (v: number, d: number) =>
        Math.abs(v) < d ? 0 : v - Math.sign(v) * d;

      this.ox = dz(this.oriFx, this.oriDead) * this.oriGainX;
      this.oy = dz(this.oriFy, this.oriDead) * this.oriGainY;
    } else {
      this.ox = 0;
      this.oy = 0;
    }

    // 2) Extract acceleration
    let ax = 0,
      ay = 0,
      az = 0;

    if (this.source === 'linacc') {
      ax = parseFloat(imu.linAccX || 0) * this.linaccScale;
      ay = parseFloat(imu.linAccY || 0) * this.linaccScale;
      az = parseFloat(imu.linAccZ || 0) * this.linaccScale;
    } else if (this.source === 'accminusgrav') {
      ax = parseFloat(imu.accX || 0) - parseFloat(imu.gravX || 0) / 100;
      ay = parseFloat(imu.accY || 0) - parseFloat(imu.gravY || 0) / 100;
      az = parseFloat(imu.accZ || 0) - parseFloat(imu.gravZ || 0) / 100;
    } else {
      // gravdelta
      const gx = parseFloat(imu.gravX || 0) / 100;
      const gy = parseFloat(imu.gravY || 0) / 100;
      const gz = parseFloat(imu.gravZ || 0) / 100;

      if (this.prevG === null || dt <= 0) {
        this.prevG = [gx, gy, gz];
        return;
      }

      ax = (gx - this.prevG[0]) / Math.max(dt, 0.001);
      ay = (gy - this.prevG[1]) / Math.max(dt, 0.001);
      az = (gz - this.prevG[2]) / Math.max(dt, 0.001);
      this.prevG = [gx, gy, gz];
    }

    // Rotate to world frame
    const [awx, awy, awz] = qRotateVector(qrel, [ax, ay, az]);
    const aMag = Math.sqrt(awx * awx + awy * awy + awz * awz);

    // 2a) Shake detection
    if (aMag > this.shakeAccThreshold) {
      this.shakeUntil = now + this.shakeHold;
      inShake = true;
    }

    // 3) Filter, deadzone, saturation
    const aWorld = [awx, awy, awz];
    for (let i = 0; i < 3; i++) {
      this.af[i] =
        (1 - this.alpha) * this.af[i] +
        this.alpha * Math.max(-this.satAcc, Math.min(this.satAcc, aWorld[i]));
      if (Math.abs(this.af[i]) < this.deadzone) {
        this.af[i] = 0;
      }
    }

    // 4) Shake hold: reset velocity and spring position
    if (inShake) {
      this.v = [0, 0, 0];
      const k = Math.min(1, this.pSpring * dt);
      for (let i = 0; i < 3; i++) {
        this.p[i] *= 1 - k;
      }
      return;
    }

    // 5) Auto-ZUPT
    if (aMag < this.quietA) {
      this.quietT += dt;
    } else {
      this.quietT = 0;
    }

    if (this.quietT >= this.zuptTime) {
      this.v = [0, 0, 0];
      const k = Math.min(1, this.pSpring * dt);
      for (let i = 0; i < 3; i++) {
        this.p[i] *= 1 - k;
      }
    }

    // 6) Integrate velocity with leak
    if (stationary) {
      this.v = [0, 0, 0];
    } else {
      const ld = Math.max(0, Math.min(1, this.leak * dt));
      for (let i = 0; i < 3; i++) {
        this.v[i] = (1 - ld) * this.v[i] + this.af[i] * dt;
        this.v[i] = Math.max(-this.satVel, Math.min(this.satVel, this.v[i]));
      }
    }

    // 7) Integrate position
    for (let i = 0; i < 3; i++) {
      this.p[i] += this.v[i] * dt;
      this.p[i] = Math.max(-this.satPos, Math.min(this.satPos, this.p[i]));
    }
  }

  targetCell(cols: number, rows: number): [number, number] {
    // Combination: integrated position + absolute tilt
    const gx = this.p[0] * this.scaleX + this.ox;
    const gy = this.p[1] * this.scaleY + this.oy;

    let cx = Math.round((gx * 0.5 + 0.5) * (cols - 1));
    let cy = Math.round((gy * 0.5 + 0.5) * (rows - 1));

    // Hysteresis
    if (this.lastEmitCol === null) this.lastEmitCol = cx;
    if (this.lastEmitRow === null) this.lastEmitRow = cy;

    if (Math.abs(cx - this.lastEmitCol) >= this.hysteresis) {
      this.lastEmitCol = cx;
    } else {
      cx = this.lastEmitCol;
    }

    if (Math.abs(cy - this.lastEmitRow) >= this.hysteresis) {
      this.lastEmitRow = cy;
    } else {
      cy = this.lastEmitRow;
    }

    // Clamp
    cx = Math.max(0, Math.min(cols - 1, cx));
    cy = Math.max(0, Math.min(rows - 1, cy));

    return [cx, cy];
  }
}
