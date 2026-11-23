// Vrstva pohybu ruky -> kurzor (utils/gloveCursor.ts), spoločná pre Pentomino, Tetris a presúvanie blokov.
// Prečo: Tetris a presúvanie blokov ju prevzali z Pentomina; tieto testy strážia správanie, na ktoré sa hry spoliehajú
// (kurzor stojí pri stisku a uvoľnení, neskočí pri vynulovaní, 3 s držanie len kde to hra dovolí, blok ide za rukou od svojej polohy).
import { describe, it, expect, beforeEach } from 'vitest';
import { installMemoryStorage } from '../../__tests__/helpers/memoryStorage';
import {
  GloveCursor, HoldFollow, cellToPos, posToCell, GRIP_FREEZE_MS, CALIB_HOLD_MS, RELEASE_FREEZE_MS,
} from '../gloveCursor';
import { NORMAL_PROFILE } from '../imuController';

type Q = { w: number; x: number; y: number; z: number };
const mul = (a: Q, b: Q): Q => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});
const axisAngle = (ax: readonly number[], deg: number): Q => {
  const n = Math.hypot(ax[0], ax[1], ax[2]);
  const h = (deg * Math.PI) / 360, s = Math.sin(h) / n;
  return { w: Math.cos(h), x: ax[0] * s, y: ax[1] * s, z: ax[2] * s };
};
// zvyčajná poloha pravej rukavice (zo záznamu)
const REST: Q = { w: -0.00079345703125, x: -0.344482421875, y: -0.69818115234375, z: -0.6275634765625 };
const H = NORMAL_PROFILE.eH; // otočenie okolo tejto osi = pohyb kurzora vodorovne

/** Simulované sedenie: vzorky každých 8 ms (125 Hz) s otočením ruky o `deg` okolo osi `ax` od REST. */
function session(glove: GloveCursor, hand: 'left' | 'right' = 'right') {
  let t = 1000;
  const run = (deg: number, ms: number, hold = false, ax: readonly number[] = H) => {
    let st = null as ReturnType<GloveCursor['step']> | null;
    for (let i = 0; i < ms / 8; i++) {
      t += 8;
      const q = mul(REST, axisAngle(ax, deg));
      const sample = { imu: { quatW: q.w, quatX: q.x, quatY: q.y, quatZ: q.z, gyroX: 0, gyroY: 0, gyroZ: 0 }, adc: [0, 0, 0, 0, 0, 0], fingers: { count: hold ? 5 : 0 }, ts: t };
      st = glove.step({ sample: sample as any, hand, hold, dt: 0.008, now: t });
    }
    return st!;
  };
  run(0, 300); // prvá vzorka je nulový bod (ako pri nasadení rukavice)
  return { run, now: () => t };
}

beforeEach(() => { installMemoryStorage(); });

describe('GloveCursor', () => {
  it('náklon ruky hýbe kurzorom a kurzor neprekročí okraj poľa', () => {
    const g = new GloveCursor();
    const s = session(g);
    expect(Math.abs(s.run(0, 400).position.x)).toBeLessThan(0.01);
    const moved = s.run(12, 600).position;
    expect(Math.abs(moved.x)).toBeGreaterThan(0.2);
    expect(Math.abs(moved.x)).toBeGreaterThan(3 * Math.abs(moved.y)); // vodorovný pohyb ostáva vodorovný
    const far = s.run(80, 800).position;
    expect(Math.abs(far.x)).toBeLessThanOrEqual(1);
  });

  it('pri stisku kurzor stojí, aj keď sa ruka stiskom pohne', () => {
    const g = new GloveCursor();
    const s = session(g);
    const before = s.run(6, 600).position;
    const during = s.run(10, GRIP_FREEZE_MS - 40, true).position; // ruka sa pri stisku nakloní o 4°
    expect(during.x).toBeCloseTo(before.x, 3);
    expect(during.y).toBeCloseTo(before.y, 3);
  });

  it('vynulovanie náklonu pri stisku kurzor neposunie: ďalší pohyb ide od miesta stisku', () => {
    const g = new GloveCursor();
    const s = session(g);
    s.run(8, 600);
    const held = s.run(8, 600, true).position; // po GRIP_RECENTER_MS sa vynuluje v polohe stisku
    const after = s.run(8, 200, true).position;
    expect(after.x).toBeCloseTo(held.x, 2);
    const further = s.run(14, 400, true).position;
    expect(Math.sign(further.x - held.x)).toBe(Math.sign(held.x)); // rovnaký smer pohybu ruky = ďalej rovnakým smerom
  });

  it('po uvoľnení kurzor chvíľu stojí (prsty pri otváraní nakláňajú rukavicu)', () => {
    const g = new GloveCursor();
    const s = session(g);
    s.run(5, 400);
    const held = s.run(5, 400, true).position;
    const released = s.run(9, RELEASE_FREEZE_MS - 50).position;
    expect(released.x).toBeCloseTo(held.x, 2);
  });

  it('3 s stisk bez pohybu je nový nulový bod len ak to hra povolí', () => {
    const noCal = new GloveCursor();
    const a = session(noCal);
    a.run(10, 600);
    let st = a.run(10, CALIB_HOLD_MS + 500, true);
    expect(st.calibrated).toBe(false);
    expect(st.calibProg).toBe(0);
    expect(Math.abs(st.position.x)).toBeGreaterThan(0.1);

    const cal = new GloveCursor({ canCalibrate: () => true });
    const b = session(cal);
    b.run(10, 600);
    let done = false;
    let sawProgress = false;
    for (let i = 0; i < 600 && !done; i++) {
      st = b.run(10, 8, true); // po jednej vzorke: "calibrated" platí len v tej vzorke, kde sa dokončí
      if (st.calibProg > 0) sawProgress = true;
      done = st.calibrated;
    }
    expect(sawProgress).toBe(true);
    expect(done).toBe(true);
    expect(st.position).toEqual({ x: 0, y: 0 });
  });

  it('setPosition: kurzor sa presunie bez skoku pri ďalšom pohybe ruky', () => {
    const g = new GloveCursor();
    const s = session(g);
    s.run(6, 600);
    g.setPosition({ x: -0.5, y: 0.25 });
    const st = s.run(6, 300);
    expect(st.position.x).toBeCloseTo(-0.5, 2);
    expect(st.position.y).toBeCloseTo(0.25, 2);
  });
});

describe('HoldFollow (relatívny presun bloku stiskom)', () => {
  it('bunka <-> poloha kurzora', () => {
    expect(cellToPos(0, 10)).toBe(-1);
    expect(cellToPos(9, 10)).toBe(1);
    expect(posToCell(cellToPos(3, 10), 10)).toBeCloseTo(3);
  });

  it('na začiatku stisku je cieľ presne poloha bloku, pohyb ruky ho posúva', () => {
    const g = new GloveCursor();
    const s = session(g);
    s.run(0, 400);
    const f = new HoldFollow(10, 20);
    expect(f.target(g.position)).toBeNull();
    f.begin(g, 3, 7);
    let st = s.run(0, GRIP_FREEZE_MS + 100, true);
    expect(f.target(st.position)).toEqual({ x: 3, y: 7 });
    st = s.run(15, 600, true);
    const t = f.target(st.position)!;
    expect(t.x).not.toBe(3);
    expect(Math.abs(t.y - 7)).toBeLessThanOrEqual(1);
    f.end();
    expect(f.target(st.position)).toBeNull();
  });

  it('blok so súradnicou mimo poľa (tetromino s prázdnym stĺpcom) si ponechá posun', () => {
    const g = new GloveCursor();
    const s = session(g);
    s.run(0, 300);
    const f = new HoldFollow(10, 20);
    f.begin(g, -1, 0);
    const st = s.run(0, 300, true);
    expect(f.target(st.position)).toEqual({ x: -1, y: 0 });
  });
});
