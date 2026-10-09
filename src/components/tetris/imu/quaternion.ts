// ==================== POMÔCKY PRE QUATERNIONY ====================
// Matematika quaternionov pre orientáciu IMU

export type Quaternion = [number, number, number, number]; // [w, x, y, z]
export type Vec3 = [number, number, number];

export function qFromIMU(imu: any): Quaternion | null {
  try {
    const w = parseFloat(imu.quatW);
    const x = parseFloat(imu.quatX);
    const y = parseFloat(imu.quatY);
    const z = parseFloat(imu.quatZ);

    const n = Math.sqrt(w * w + x * x + y * y + z * z);
    if (n === 0) return null;

    return [w / n, x / n, y / n, z / n];
  } catch {
    return null;
  }
}

export function qConjugate(q: Quaternion): Quaternion {
  return [q[0], -q[1], -q[2], -q[3]];
}

export function qMultiply(a: Quaternion, b: Quaternion): Quaternion {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;

  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function qRotateVector(q: Quaternion, v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  const [vx, vy, vz] = v;

  // q * v
  const rw = -x * vx - y * vy - z * vz;
  const rx = w * vx + y * vz - z * vy;
  const ry = w * vy + z * vx - x * vz;
  const rz = w * vz + x * vy - y * vx;

  // (q * v) * q_conj
  const vx2 = -rw * y + rx * z - ry * w - rz * x;
  const vy2 = -rw * z - rx * y + ry * x - rz * w;
  const vz2 = rw * w + rx * x + ry * y + rz * z;

  return [vx2, vy2, vz2];
}

export function qToEuler(q: Quaternion): {
  roll: number;
  pitch: number;
  yaw: number;
} {
  const [w, x, y, z] = q;

  // Roll (rotácia okolo osi x)
  const sinr_cosp = 2 * (w * x + y * z);
  const cosr_cosp = 1 - 2 * (x * x + y * y);
  const roll = Math.atan2(sinr_cosp, cosr_cosp) * (180 / Math.PI);

  // Pitch (rotácia okolo osi y)
  const sinp = 2 * (w * y - z * x);
  const pitch = Math.asin(Math.max(-1, Math.min(1, sinp))) * (180 / Math.PI);

  // Yaw (rotácia okolo osi z)
  const siny_cosp = 2 * (w * z + x * y);
  const cosy_cosp = 1 - 2 * (y * y + z * z);
  const yaw = Math.atan2(siny_cosp, cosy_cosp) * (180 / Math.PI);

  return { roll, pitch, yaw };
}
