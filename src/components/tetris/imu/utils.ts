// ==================== IMU UTILITIES ====================
// Helper funkcie pre extrahovanie IMU dát
import { scaleGyro } from '../../../utils/imuNormalize';

export function imuExtractAxis(imu: any, axis: 'x' | 'y' | 'z'): number | null {
  if (!imu || typeof imu !== 'object') return null;

  const a = axis.toLowerCase();
  const camelMap: Record<string, string> = {
    x: 'gyroX',
    y: 'gyroY',
    z: 'gyroZ',
  };

  const camel = camelMap[a];
  if (camel in imu) {
    try {
      return scaleGyro(imu[camel]);
    } catch {
      return null;
    }
  }

  // Try gyro object
  for (const key of ['gyro', 'GYRO']) {
    if (key in imu) {
      const g = imu[key];
      if (typeof g === 'object') {
        const v = g[a] || g[a.toUpperCase()];
        return v !== null && v !== undefined ? parseFloat(v) : null;
      }
    }
  }

  // Try direct keys
  for (const k of [`g${a}`, `G${a.toUpperCase()}`]) {
    if (k in imu) {
      try {
        return parseFloat(imu[k]);
      } catch {
        return null;
      }
    }
  }

  return null;
}

export function imuExtractVector(
  imu: any,
  keyLower: string
): [number, number, number] | null {
  if (!imu || typeof imu !== 'object') return null;

  for (const k of [keyLower, keyLower.toUpperCase()]) {
    if (k in imu) {
      const v = imu[k];

      if (Array.isArray(v) && v.length >= 3) {
        try {
          return [parseFloat(v[0]), parseFloat(v[1]), parseFloat(v[2])];
        } catch {
          return null;
        }
      }

      if (typeof v === 'object') {
        const x = v.x || v.X || v.roll || v.ROLL;
        const y = v.y || v.Y || v.pitch || v.PITCH;
        const z = v.z || v.Z || v.yaw || v.YAW;

        if (
          x !== null &&
          x !== undefined &&
          y !== null &&
          y !== undefined &&
          z !== null &&
          z !== undefined
        ) {
          try {
            return [parseFloat(x), parseFloat(y), parseFloat(z)];
          } catch {
            return null;
          }
        }
      }
    }
  }

  return null;
}
