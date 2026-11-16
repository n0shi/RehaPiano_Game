// UNIT (jedna trieda, žiadne závislosti): zosilnenie kurzora podľa rýchlosti ruky (utils/speedGain.ts).
// Prečo: od tohto závisí, či sa blok dá presne dosadiť (pomalý pohyb) a či ruka dočiahne cez celé pole (rýchly pohyb).
import { describe, it, expect } from 'vitest';
import { SpeedGain, PENTOMINO_SPEED_GAIN as CFG } from '../speedGain';

const DT = 0.008; // rukavica posiela ~125 vzoriek/s

/** Posúva vstup rovnomerne doprava rýchlosťou `speed` (rozsah/s) počas `seconds`; vráti posun vstupu a výstupu. */
function sweep(g: SpeedGain, speed: number, seconds: number) {
  let x = 0;
  const start = g.apply({ x, y: 0 }, DT);
  let out = start;
  for (let t = 0; t < seconds; t += DT) { x += speed * DT; out = g.apply({ x, y: 0 }, DT); }
  return { input: x, output: out.x - start.x };
}

describe('SpeedGain', () => {
  it('prvá vzorka: výstup = vstup (kurzor pri štarte neskočí)', () => {
    expect(new SpeedGain(CFG).apply({ x: 0.4, y: -0.2 }, DT)).toEqual({ x: 0.4, y: -0.2 });
  });

  it('pomalý pohyb sa zmenší (presné dosadnutie bloku)', () => {
    const r = sweep(new SpeedGain(CFG), CFG.slowSpeed / 2, 1);
    expect(r.output / r.input).toBeCloseTo(CFG.slowGain, 2);
  });

  it('rýchly pohyb sa zväčší (dosah cez celé pole)', () => {
    const r = sweep(new SpeedGain(CFG), CFG.fastSpeed * 2, 1);
    expect(r.output).toBeGreaterThan(r.input);
    expect(r.output / r.input).toBeLessThanOrEqual(CFG.fastGain);
  });

  it('zosilnenie rastie s rýchlosťou plynulo a ostáva medzi slowGain a fastGain', () => {
    let prev = 0;
    for (const speed of [0.1, 0.3, 0.6, 0.9, 1.2, 1.5, 3]) {
      const g = new SpeedGain(CFG);
      sweep(g, speed, 1);
      expect(g.gain()).toBeGreaterThanOrEqual(prev);
      expect(g.gain()).toBeGreaterThanOrEqual(CFG.slowGain);
      expect(g.gain()).toBeLessThanOrEqual(CFG.fastGain);
      prev = g.gain();
    }
  });

  it('chvenie ruky na mieste kurzor neodnesie preč', () => {
    const g = new SpeedGain(CFG);
    let out = g.apply({ x: 0, y: 0 }, DT);
    for (let i = 0; i < 1000; i++) out = g.apply({ x: i % 2 ? 0.004 : -0.004, y: 0 }, DT);
    expect(Math.abs(out.x)).toBeLessThan(0.01);
    expect(out.y).toBe(0);
  });

  it('reset (vynulovanie náklonu): výstup preskočí na vstup a prírastok sa nezapočíta', () => {
    const g = new SpeedGain(CFG);
    sweep(g, 2, 0.5);
    expect(g.apply({ x: 0, y: 0 }, DT, true)).toEqual({ x: 0, y: 0 });
    expect(g.gain()).toBe(CFG.slowGain);
  });
});
