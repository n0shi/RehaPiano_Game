// imuController.ts
// Single-IMU controller for mapping IMU+tensometer -> normalized cursor + gestures
import { normalizeImuSample, normalizeAdc, GYRO_DIVISOR, type RawIMU } from './imuNormalize';
export type { RawIMU };

export type Sample = {
  imu: RawIMU;
  adc: number[];
  ts?: number;
};

type Quat = { w: number; x: number; y: number; z: number };
type Vec3 = [number, number, number];

function ema(prev: number, cur: number, alpha: number) {
  return prev + alpha * (cur - prev);
}

function quatConjugate(q: Quat): Quat {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

function rotateVecByQuat(q: Quat, v: Vec3): Vec3 {
  const qv: Quat = { w: 0, x: v[0], y: v[1], z: v[2] };
  const tmp = quatMultiply(q, qv);
  const res = quatMultiply(tmp, quatConjugate(q));
  return [res.x, res.y, res.z];
}

export const TILT_ROTATION_RIGHT_DEG = 46; // korekcia natočenia senzora pravej rukavice (pozri tiltRotationDeg)

export const SHEAR_UP_RIGHT_HAND = 0.23;    // pri pohybe hore ruka uhýna doprava: x += 0.23*min(y,0) (v súradniciach obrazovky)
export const SHEAR_RIGHT_RIGHT_HAND = 0.18; // pri pohybe doprava ruka uhýna dole: y -= 0.18*max(x,0)

export class SingleIMUController {
  private fPitch = 0;
  private fRoll = 0;
  private fGyroX = 0;
  private fGyroY = 0;
  private fGyroZ = 0;
  private lpLinAccX = 0;
  private lpLinAccY = 0;

  private posX = 0; // normalized -1..1
  private posY = 0;

  // === Plynulá interpolácia grid pozície ===
  private targetGridX = 0;
  private targetGridY = 0;
  private smoothGridX = 0;
  private smoothGridY = 0;
  private lastEmittedGridX = -1;
  private lastEmittedGridY = -1;
  public gridSmoothAlpha = 0.12; // Nižšia hodnota = plynulejší pohyb (0.08-0.2)
  public cellHysteresis = 0.25; // o koľko bunky za hranicu musí vyhladená poloha prejsť, aby sa bunka zmenila (0.2-0.3)

  // === Gyro hysterézia pre lepšiu separáciu akcií ===
  private gyroZWasReleased = true;
  private gyroXWasReleased = true;
  private gyroYWasReleased = true;
  private gyroZReleasedAt = 0; // Kedy začal byť gyroskop pod thresholdom
  private gyroXReleasedAt = 0;
  private gyroYReleasedAt = 0;
  public gyroReleaseThreshold = 8; // °/s - gyroskop musí klesnúť pod túto hodnotu
  public gyroReleaseTimeMs = 500; // ms - ako dlho musí byť pod thresholdom

  // quaternion calibration: neutral pose
  private qNeutralInv: Quat | null = null;

  // tuning
  public gyroDivisor = GYRO_DIVISOR; // 1 = streamer už posiela gyro v °/s
  public alphaOrient = 0.18;
  public deadzoneDeg = 3;
  public maxTiltDeg = 25;
  public maxSpeed = 1.0;
  public gridSize = 20;
  public precisionScale = 1.5;
  public lpAlphaHP = 0.18;
  public posAlpha = 0.28;


  public tiltClamp = 0.8;
  public tiltGain = 1.35;     
  public tiltDeadzone = 0.05;  
  // true = izotropný náklon (kruhová mŕtva zóna a kruhové obmedzenie, žiadne tanh po osiach),
  // takže diagonály sú rovnako dosiahnuteľné ako osi. Používa kurzor v menu/kalibrácii; hry ostávajú na false.
  public linearTilt = false;
  // Otočenie vektora náklonu (°) v rovine X/Y: senzor v rukavici je voči ruke natočený (~46°), takže pohyb doprava
  // išiel šikmo dole a hore/dole šikmo do strán. Namerané z nahrávky (zhoda všetkých 4 smerov). 0 = bez korekcie.
  public tiltRotationDeg = 0;
  // true = náklon sa berie z uhla otočenia (rotačný vektor) namiesto priemetu osi Z. Priemet má tvar sin(uhol): pri veľkom
  // náklone saturuje a nakoniec obráti smer (čiara sa pri dlhom ťahu "zalomí"). Uhol je lineárny a otočenie okolo Z
  // (rotácia zápästia) kurzor nehýbe. Pri malých uhloch je výsledok rovnaký ako pri priemete.
  public angleTilt = false;
  // Doladenie po otočení (súradnice obrazovky: x doprava, y dole): oblúk zápästia ťahá pri pohybe hore doprava a pri pohybe
  // doprava dole. Opravuje sa len príslušná polovica osi (dole/doľava namerané sedeli). Hodnoty sú pre pravú ruku.
  public shearUp = 0;
  // Zosilenie náklonu (po korekciách, pred obmedzením na ±1): bežný náklon ruky dá len ~±0,5, takže 2 dosiahne celý rozsah.
  public posGain = 1;
  public shearRight = 0;

  private lastGestureTs = 0;
  private gestureCooldownMs = 300;

  public pickThreshold = 0.4;
  public releaseThreshold = 0.25;
  private gripActive = false;

  constructor() {}

  public calibrateNeutral(qCurrent: Quat) {
    this.qNeutralInv = quatConjugate(qCurrent);
  }

  // Offsety pre fallback (pitch/roll) – nastavuje recenter()
  private pitchOffset = 0;
  private rollOffset = 0;

  /**
   * Prenastaví neutrálnu pozíciu na aktuálnu polohu ruky (volať pri stlačení všetkých prstov),
   * aby sa náklon nevzďaľoval od nuly a minimálny pohyb nespúšťal veľký posun/otočenie.
   */
  public recenter(rawImu: any) {
    const imu = normalizeImuSample(rawImu, this.gyroDivisor);
    if (imu.quat && imu.quat.w !== undefined) {
      this.calibrateNeutral(imu.quat);
    }
    this.pitchOffset = imu.pitchDeg;
    this.rollOffset = imu.rollDeg;
    this.fPitch = imu.pitchDeg;
    this.fRoll = imu.rollDeg;
    this.posX = 0;
    this.posY = 0;
    this.resetPosition(); // kurzor ihneď na stred, aby sa po recentre nešmýkal
  }

  public update(sample: Sample, dtSec: number) {
    const t = sample.ts ?? performance.now();
    const imu = normalizeImuSample(sample.imu, this.gyroDivisor);

    this.fPitch = ema(this.fPitch, imu.pitchDeg, this.alphaOrient);
    this.fRoll = ema(this.fRoll, imu.rollDeg, this.alphaOrient);
    this.fGyroX = ema(this.fGyroX, imu.gyroX_dps, 0.12);
    this.fGyroY = ema(this.fGyroY, imu.gyroY_dps, 0.12);
    this.fGyroZ = ema(this.fGyroZ, imu.gyroZ_dps, 0.12);

    // HP on linAcc
    const aX = imu.linAccX;
    const aY = imu.linAccY;
    this.lpLinAccX = ema(this.lpLinAccX, aX, this.lpAlphaHP);
    this.lpLinAccY = ema(this.lpLinAccY, aY, this.lpAlphaHP);
    const hpX = aX - this.lpLinAccX;
    const hpY = aY - this.lpLinAccY;

        const fingers = (sample.adc || []).slice(1,5);
    const maxGrip = fingers.length ? Math.max(...fingers.map(normalizeAdc)) : 0;
    if (!this.gripActive && maxGrip > this.pickThreshold) this.gripActive = true;
    else if (this.gripActive && maxGrip < this.releaseThreshold) this.gripActive = false;

    const precision = this.gripActive ? this.precisionScale : 1.0;

  // Quaternion mapovanie kurzora
    let nx = 0, ny = 0;
    if (imu.quat && imu.quat.w !== undefined) {
      
      let q = imu.quat;
      if (this.qNeutralInv) {
        q = quatMultiply(this.qNeutralInv, q);
      }

      // To find tilt, rotate the world "up" vector by the INVERSE of device orientation
      // This tells us which way "up" points in the device's local frame
      const qInv = quatConjugate(q);
      const worldUp: Vec3 = [0, 0, 1]; // world frame: Z is up
      const deviceUp = rotateVecByQuat(qInv, worldUp);
      let tiltX = deviceUp[1]; // horizontal
      let tiltY = deviceUp[0]; // vertical
      if (this.angleTilt) {
        const sgn = q.w < 0 ? -1 : 1; // q a -q sú to isté otočenie
        const vx = sgn * q.x, vy = sgn * q.y, vz = sgn * q.z;
        const vn = Math.hypot(vx, vy, vz);
        if (vn > 1e-6) {
          const ang = 2 * Math.atan2(vn, sgn * q.w); // rad, 0..π
          tiltX = (vx / vn) * ang;
          tiltY = -(vy / vn) * ang;
        } else {
          tiltX = 0; tiltY = 0;
        }
      }
      
      // deviceUp now shows where world-up points in device coordinates
      // If device tilts right, deviceUp.y becomes negative (up is to the left in device frame)
      // If device tilts forward, deviceUp.x becomes negative (up is behind in device frame)
      
  if (this.linearTilt) {
    // Vektor náklonu (X,Y) sa škáluje ako celok: smer sa zachová (aj diagonálny), obmedzuje sa len dĺžka
    const vx = tiltX / this.tiltClamp;
    const vy = tiltY / this.tiltClamp;
    const mag = Math.hypot(vx, vy);
    const dzr = this.tiltDeadzone / this.tiltClamp;
    if (mag > dzr) {
      const k = Math.min(1, (mag - dzr) / (1 - dzr)) / mag;
      nx = vx * k * precision;
      ny = vy * k * precision;
    }
  } else {
  // Apply small deadzone to suppress noise
  const dz = this.tiltDeadzone;
  const upX = Math.abs(tiltX) < dz ? 0 : tiltX; // horizontal
  const upY = Math.abs(tiltY) < dz ? 0 : tiltY; // vertical

  // Clamp and shape: scale by tiltClamp (smaller -> more sensitive), then tanh with tiltGain
  const sx = upX / this.tiltClamp;
  const sy = upY / this.tiltClamp;
  const shapedX = Math.tanh(this.tiltGain * sx);
  const shapedY = Math.tanh(this.tiltGain * sy);

  nx = shapedX * precision;
  ny = shapedY * precision;
  }
    } else {
      // Fallback: use pitch/roll (Euler-based) if no quat
      const pitch = Math.abs(this.fPitch - this.pitchOffset) < this.deadzoneDeg ? 0 : this.fPitch - this.pitchOffset;
      const roll = Math.abs(this.fRoll - this.rollOffset) < this.deadzoneDeg ? 0 : this.fRoll - this.rollOffset;

      const normTilt = (v: number) => {
        const c = Math.max(-1, Math.min(1, v / this.maxTiltDeg));
        return Math.sign(c) * Math.pow(Math.abs(c), 3);
      };

      nx = normTilt(roll) * precision;
      ny = normTilt(pitch) * precision;
    }

    if (this.tiltRotationDeg !== 0 && imu.quat && imu.quat.w !== undefined) {
      const a = (this.tiltRotationDeg * Math.PI) / 180;
      const rx = nx * Math.cos(a) - ny * Math.sin(a);
      const ry = nx * Math.sin(a) + ny * Math.cos(a);
      nx = rx; ny = ry;
    }
    if ((this.shearUp !== 0 || this.shearRight !== 0) && imu.quat && imu.quat.w !== undefined) {
      const sx = -nx, sy = ny; // pravá ruka: obrazovka x = -nx
      nx = -(sx + this.shearUp * Math.min(sy, 0));
      ny = sy - this.shearRight * Math.max(sx, 0);
    }

    nx *= this.posGain;
    ny *= this.posGain;

    // Smoothly move pos towards target normalized tilt
    this.posX = ema(this.posX, nx, this.posAlpha);
    this.posY = ema(this.posY, ny, this.posAlpha);
    this.posX = Math.max(-1, Math.min(1, this.posX));
    this.posY = Math.max(-1, Math.min(1, this.posY));

    // === Aktualizuj hysteréziu gyroskopu s časovou podmienkou ===
    // Gyroskop musí byť pod thresholdom aspoň gyroReleaseTimeMs pred ďalšou akciou
    if (Math.abs(this.fGyroZ) < this.gyroReleaseThreshold) {
      // Začalo uvoľňovanie - zapiš čas ak ešte nebol
      if (this.gyroZReleasedAt === 0) {
        this.gyroZReleasedAt = t;
      }
      // Skontroluj či už prešiel dostatočne dlhý čas
      if (t - this.gyroZReleasedAt >= this.gyroReleaseTimeMs) {
        this.gyroZWasReleased = true;
      }
    } else {
      // Gyroskop je nad thresholdom - resetuj čas
      this.gyroZReleasedAt = 0;
    }
    
    if (Math.abs(this.fGyroX) < this.gyroReleaseThreshold) {
      if (this.gyroXReleasedAt === 0) {
        this.gyroXReleasedAt = t;
      }
      if (t - this.gyroXReleasedAt >= this.gyroReleaseTimeMs) {
        this.gyroXWasReleased = true;
      }
    } else {
      this.gyroXReleasedAt = 0;
    }
    
    // Gyro Y hysterézia (pre prepínanie blokov)
    if (Math.abs(this.fGyroY) < this.gyroReleaseThreshold) {
      if (this.gyroYReleasedAt === 0) {
        this.gyroYReleasedAt = t;
      }
      if (t - this.gyroYReleasedAt >= this.gyroReleaseTimeMs) {
        this.gyroYWasReleased = true;
      }
    } else {
      this.gyroYReleasedAt = 0;
    }

    let gesture: string | null = null;
    if (t - this.lastGestureTs > this.gestureCooldownMs) {
      if (hpX > 0.9) { gesture = 'flick-right'; this.lastGestureTs = t; }
      else if (hpX < -0.9) { gesture = 'flick-left'; this.lastGestureTs = t; }
      else if (hpY > 1.0) { gesture = 'flick-up'; this.lastGestureTs = t; }
      else if (hpY < -1.0) { gesture = 'flick-down'; this.lastGestureTs = t; }
    }

    // === Plynulá interpolácia grid pozície s hysteréziou ===
    const rawGridX = ((this.posX * 0.5) + 0.5) * (this.gridSize - 1);
    const rawGridY = ((this.posY * 0.5) + 0.5) * (this.gridSize - 1);
    
    this.targetGridX = Math.max(0, Math.min(this.gridSize - 1, rawGridX));
    this.targetGridY = Math.max(0, Math.min(this.gridSize - 1, rawGridY));
    
    // Plynulý prechod k cieľovej pozícii pomocou EMA
    this.smoothGridX = ema(this.smoothGridX, this.targetGridX, this.gridSmoothAlpha);
    this.smoothGridY = ema(this.smoothGridY, this.targetGridY, this.gridSmoothAlpha);
    
    // Hysterézia: bunka sa zmení až keď vyhladená poloha prejde za hranicu o `cellHysteresis`
    // (0.5 = hranica susednej bunky + rezerva), takže chvenie na hranici bunky nič neprepína.
    let gx = this.lastEmittedGridX;
    let gy = this.lastEmittedGridY;

    if (this.lastEmittedGridX < 0) {
      gx = Math.round(this.smoothGridX);
      gy = Math.round(this.smoothGridY);
    } else {
      const limit = 0.5 + this.cellHysteresis;
      if (Math.abs(this.smoothGridX - gx) > limit) gx = Math.round(this.smoothGridX);
      if (Math.abs(this.smoothGridY - gy) > limit) gy = Math.round(this.smoothGridY);
    }

    gx = Math.max(0, Math.min(this.gridSize - 1, gx));
    gy = Math.max(0, Math.min(this.gridSize - 1, gy));
    this.lastEmittedGridX = gx;
    this.lastEmittedGridY = gy;

    return {
      posNorm: { x: this.posX, y: this.posY },
      grid: { x: gx, y: gy },
      smoothGrid: { x: this.smoothGridX, y: this.smoothGridY },
      grip: this.gripActive,
      precision,
      gesture,
      rotateGesture: Math.abs(this.fGyroZ) > 150 ? (this.fGyroZ > 0 ? 'rotate-cw' : 'rotate-ccw') : null,
      // expose smoothed gyro rates for external mapping (deg/s)
      gyro: { x: this.fGyroX, y: this.fGyroY, z: this.fGyroZ },
      // === Nové: Flagy pre hysteréziu gyroskopu ===
      gyroZWasReleased: this.gyroZWasReleased,
      gyroXWasReleased: this.gyroXWasReleased,
      gyroYWasReleased: this.gyroYWasReleased,
      snap: this.gripActive ? { snapX: gx, snapY: gy } : null,
    };
  }

  // === Metódy na označenie, že gesto bolo vykonané ===
  public consumeGyroZ() {
    this.gyroZWasReleased = false;
  }
  
  public consumeGyroX() {
    this.gyroXWasReleased = false;
  }
  
  public consumeGyroY() {
    this.gyroYWasReleased = false;
  }

  // === Reset pozície (volať pri zmene levelu) ===
  public resetPosition(gridX?: number, gridY?: number) {
    const x = gridX ?? (this.gridSize - 1) / 2;
    const y = gridY ?? (this.gridSize - 1) / 2;
    this.smoothGridX = x;
    this.smoothGridY = y;
    this.targetGridX = x;
    this.targetGridY = y;
    this.lastEmittedGridX = Math.round(x);
    this.lastEmittedGridY = Math.round(y);
  }

  public calibrateZero(pitchDeg: number, rollDeg: number) {
    this.fPitch = pitchDeg;
    this.fRoll = rollDeg;
  }
}

export default SingleIMUController;
