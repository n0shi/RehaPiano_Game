// imuNormalize.ts
// Single source of truth for converting raw device IMU/ADC units into physical units.

export type RawIMU = {
  pitch?: number; roll?: number; yaw?: number;
  gyroX?: number; gyroY?: number; gyroZ?: number;
  linAccX?: number; linAccY?: number; linAccZ?: number;
  gravX?: number; gravY?: number; gravZ?: number;
  quatW?: number; quatX?: number; quatY?: number; quatZ?: number;
};

// Euler angles (pitch/roll/yaw) already arrive in degrees -> no scaling.
// (Dividing by 16 shrank the range to ~-11..11 and broke thresholds.)
export const ANGLE_DIVISOR = 1;
// Gyro: raw -1034..+1144 / 16 -> realistic -64.6..+71.5 deg/s (confirmed on real data).
export const GYRO_DIVISOR = 16;
export const LINACC_DIVISOR = 100;
export const GRAV_DIVISOR = 100;
export const ADC_FULL_SCALE = 128;

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(v as any);
  return Number.isFinite(n) ? n : 0;
};

export const scaleAngle = (v: unknown) => num(v) / ANGLE_DIVISOR;
export const scaleGyro = (v: unknown) => num(v) / GYRO_DIVISOR;
export const scaleLinAcc = (v: unknown) => num(v) / LINACC_DIVISOR;
export const scaleGrav = (v: unknown) => num(v) / GRAV_DIVISOR;
/** ADC channel -> 0..1 magnitude. */
export const normalizeAdc = (v: unknown) => Math.abs(num(v)) / ADC_FULL_SCALE;

export function normalizeImuSample(raw: RawIMU | any, gyroDivisor: number = GYRO_DIVISOR) {
  const r = raw ?? {};
  return {
    pitchDeg: scaleAngle(r.pitch),
    rollDeg: scaleAngle(r.roll),
    yawDeg: scaleAngle(r.yaw),
    gyroX_dps: num(r.gyroX) / gyroDivisor,
    gyroY_dps: num(r.gyroY) / gyroDivisor,
    gyroZ_dps: num(r.gyroZ) / gyroDivisor,
    linAccX: scaleLinAcc(r.linAccX),
    linAccY: scaleLinAcc(r.linAccY),
    linAccZ: scaleLinAcc(r.linAccZ),
    gravX: scaleGrav(r.gravX),
    gravY: scaleGrav(r.gravY),
    gravZ: scaleGrav(r.gravZ),
    quat: r.quatW !== undefined ? {
      w: num(r.quatW), x: num(r.quatX), y: num(r.quatY), z: num(r.quatZ),
    } : undefined,
  };
}
